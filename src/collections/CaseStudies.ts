import { sql } from "drizzle-orm";
import {
  APIError,
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type PayloadRequest,
} from "payload";
import { caseStudyFields } from "../fields/caseStudyFields";
import { seoTab } from "../fields/seoFields";
import type { CaseStudy } from "../payload-types";

type GalleryRow = NonNullable<CaseStudy["gallery"]>[number];

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const ensureSlug: CollectionBeforeValidateHook = ({ data }) => {
  if (!data) return data;
  const source = String(data.slug || data.title || "");
  if (source) data.slug = slugify(source);
  return data;
};

const computeCaseStudyAdminTitle: CollectionBeforeValidateHook = async ({ data, req }) => {
  if (!data) return data;
  let clientName = "";
  const clientRef = data.client;
  const clientId =
    typeof clientRef === "object" && clientRef !== null
      ? (clientRef as { id?: string | number; name?: string; slug?: string }).id
      : clientRef;

  if (typeof clientRef === "object" && clientRef !== null) {
    clientName = String((clientRef as { name?: string }).name || (clientRef as { slug?: string }).slug || "").trim();
  }
  if (!clientName && clientId != null) {
    try {
      const client = await req.payload.findByID({
        collection: "clients",
        id: clientId,
        depth: 0,
        req,
      });
      clientName = String(client?.name || client?.slug || "").trim();
    } catch {}
  }

  const studyTitle = String(data.title || data.slug || "Case study").trim();
  const autoTitle = clientName ? `${clientName} — ${studyTitle}` : studyTitle;
  if (!data.adminTitle || typeof data.adminTitle !== "string" || !data.adminTitle.trim()) {
    data.adminTitle = autoTitle;
  }
  return data;
};

const uniqueSlugPerClient: CollectionBeforeValidateHook = async ({
  data,
  req,
  originalDoc,
}) => {
  if (!data?.slug || !data?.client) return data;
  const clientId =
    typeof data.client === "object" && data.client !== null
      ? (data.client as { id?: string | number }).id
      : data.client;
  if (clientId == null) return data;

  const existing = await req.payload.find({
    collection: "case-studies",
    where: {
      and: [
        { slug: { equals: data.slug } },
        { client: { equals: clientId } },
        ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []),
      ],
    },
    limit: 1,
    depth: 0,
    req,
  });
  if (existing.docs.length) {
    throw new APIError("This client already has a case study with that slug.", 400);
  }
  return data;
};

type MediaRef = { image?: unknown; alt?: string | null } | null | undefined;

function filled(value: unknown): boolean {
  return value != null && value !== "";
}

/** Hidden layout fields are omitted on save. Put the previous file back. */
const preserveHiddenMedia: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  if (!data) return data;

  const prevHero = originalDoc?.hero;
  if (data.hero && prevHero) {
    if (data.hero.layout === "split") {
      if (!filled(data.hero.image?.image) && filled(prevHero.image?.image)) {
        data.hero.image = prevHero.image;
      }
    } else {
      if (!filled(data.hero.left?.image) && filled(prevHero.left?.image)) {
        data.hero.left = prevHero.left;
      }
      if (!filled(data.hero.right?.image) && filled(prevHero.right?.image)) {
        data.hero.right = prevHero.right;
      }
    }
  }

  if (Array.isArray(data.gallery) && Array.isArray(originalDoc?.gallery)) {
    const savedGallery = originalDoc.gallery as GalleryRow[];
    const previous = new Map(
      savedGallery
        .filter((row): row is GalleryRow & { id: string } => Boolean(row?.id))
        .map((row) => [String(row.id), row]),
    );
    data.gallery = (data.gallery as GalleryRow[]).map((row) => {
      if (!row?.id) return row;
      const old = previous.get(String(row.id));
      if (!old) return row;
      if (row.layout === "split") {
        if (!filled(row.image) && filled(old.image)) row.image = old.image;
        if (!filled(row.alt) && filled(old.alt)) row.alt = old.alt;
      } else {
        const left = row.left as MediaRef;
        const right = row.right as MediaRef;
        const oldLeft = old.left as MediaRef;
        const oldRight = old.right as MediaRef;
        if (!filled(left?.image) && filled(oldLeft?.image)) row.left = old.left;
        if (!filled(right?.image) && filled(oldRight?.image)) row.right = old.right;
      }
      return row;
    });
  }

  return data;
};

type TransactionDb = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

function transactionDb(req: PayloadRequest): TransactionDb | null {
  const id = req.transactionID;
  if (id == null) return null;
  const sessions = (
    req.payload.db as { sessions?: Record<string, { db?: TransactionDb }> }
  ).sessions;
  return sessions?.[String(id)]?.db ?? null;
}

/** A failed statement aborts the whole Postgres transaction, even inside catch. */
async function protectCaseStudySave(
  req: PayloadRequest,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  const tx = transactionDb(req);
  if (tx) await tx.execute(sql.raw(`SAVEPOINT ${name}`));
  try {
    await run();
    if (tx) await tx.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
  } catch (error) {
    if (tx) {
      try {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
      } catch {
        // The transaction was already finished.
      }
    }
    req.payload.logger.error({ err: error, msg: `Case study save kept after ${name} failed.` });
  }
}

const syncCaseStudyToClient: CollectionAfterChangeHook = async ({ doc, req, context }) => {
  if (context?.skipFeaturedAttach) return doc;
  const clientRef = doc.client;
  const clientId =
    typeof clientRef === "object" && clientRef !== null
      ? (clientRef as { id?: string | number }).id
      : clientRef;
  const studyId = Number(doc.id);
  const clientIdNum = Number(clientId);
  if (!Number.isInteger(studyId) || !Number.isInteger(clientIdNum)) return doc;

  const tx = transactionDb(req);
  if (!tx) return doc;

  // One statement in this transaction. Rewriting the client through Payload
  // validates the new study before it is committed and aborts the save.
  await protectCaseStudySave(req, "case_study_client_sync", async () => {
    await tx.execute(sql`
      UPDATE clients
      SET featured_study_id = ${studyId}
      WHERE id = ${clientIdNum}
        AND project_type = 'direct'
        AND featured_study_id IS NULL
    `);
  });

  return doc;
};

export const CaseStudies: CollectionConfig = {
  slug: "case-studies",
  labels: { singular: "Case study", plural: "Case studies" },
  admin: {
    group: "Work",
    useAsTitle: "adminTitle",
    defaultColumns: ["adminTitle", "client", "slug", "updatedAt"],
    description:
      "Belongs to a Client. Hub clients can have many; a Direct client usually has one.",
  },
  access: { read: () => true },
  hooks: {
    beforeValidate: [ensureSlug, computeCaseStudyAdminTitle, uniqueSlugPerClient],
    beforeChange: [preserveHiddenMedia],
    afterChange: [syncCaseStudyToClient],
  },
  fields: [
    {
      name: "adminTitle",
      label: "Display Name (Lists & Select)",
      type: "text",
      admin: {
        position: "sidebar",
        description:
          "Shown in lists and dropdowns (e.g. Puma — Logo Design). Auto-generated from Client and Title if left empty.",
      },
    },
    {
      type: "tabs",
      tabs: [
        {
          label: "Case Study",
          fields: [
            { name: "title", type: "text", required: true },
            {
              name: "slug",
              type: "text",
              required: true,
              index: true,
              admin: {
                description:
                  "URL: /clients/{client}/{slug}. Example: case-study, website, branding.",
              },
            },
            {
              name: "client",
              type: "relationship",
              relationTo: "clients",
              required: true,
              admin: {
                description:
                  "The brand this study belongs to. If the Client does not exist yet, create and save it first — leave Featured study empty. After you save this Case study, Direct clients pick it up automatically.",
                // Required stays on for the form. The condition keeps the Postgres column
                // nullable so deleting a client clears this link instead of leaving an id
                // the admin cannot open.
                condition: () => true,
              },
            },
            ...caseStudyFields,
          ],
        },
        seoTab,
      ],
    },
  ],
};
