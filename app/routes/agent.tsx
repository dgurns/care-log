import type { Route } from "./+types/agent";
import { streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { db } from "~/db";
import { medicalDetailTable, personTable } from "~/db/schema";
import { eq, desc, asc, count, and, or, sql, type SQL } from "drizzle-orm";
import { getPersonForUser } from "~/utils/user";
import { auth } from "~/lib/auth-server";
import { redirect } from "react-router";

export async function action({ request }: Route.ActionArgs) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw redirect("/login");
  }

  const personForCurrentUser = await getPersonForUser(session.user.id);

  const { messages } = await request.json();

  // Only allow access to people (and their details) the current user created
  const isOwnedPerson = async (personId: number) => {
    const [person] = await db
      .select({ id: personTable.id })
      .from(personTable)
      .where(
        and(
          eq(personTable.id, personId),
          eq(personTable.creatorId, session.user.id),
        ),
      );
    return Boolean(person);
  };

  const getOwnedDetail = async (id: number) => {
    const [row] = await db
      .select({ detail: medicalDetailTable })
      .from(medicalDetailTable)
      .innerJoin(personTable, eq(medicalDetailTable.personId, personTable.id))
      .where(
        and(
          eq(medicalDetailTable.id, id),
          eq(personTable.creatorId, session.user.id),
        ),
      );
    return row?.detail;
  };

  // Only include the most recent details in context; the agent can use
  // listMedicalDetailsForPerson to search/paginate the rest
  const RECENT_DETAILS_LIMIT = 20;
  const [recentMedicalDetails, [{ totalMedicalDetails }]] = personForCurrentUser
    ? await Promise.all([
        db
        .select({
          id: medicalDetailTable.id,
          summary: medicalDetailTable.summary,
          person_id: medicalDetailTable.personId,
          created_at: medicalDetailTable.createdAt,
        })
        .from(medicalDetailTable)
        .where(eq(medicalDetailTable.personId, personForCurrentUser.id))
        .orderBy(desc(medicalDetailTable.createdAt), desc(medicalDetailTable.id))
        .limit(RECENT_DETAILS_LIMIT),
        db
          .select({ totalMedicalDetails: count() })
          .from(medicalDetailTable)
          .where(eq(medicalDetailTable.personId, personForCurrentUser.id)),
      ])
    : [[], [{ totalMedicalDetails: 0 }]];

  const personName = `${personForCurrentUser?.firstName} ${personForCurrentUser?.lastName}`;
  const medicalDetailsContext =
    recentMedicalDetails.length > 0
      ? `\n\n${personName} has ${totalMedicalDetails} medical detail(s) in total. ${
          totalMedicalDetails > recentMedicalDetails.length
            ? `The ${recentMedicalDetails.length} most recent are listed below; use listMedicalDetailsForPerson (with date, keyword, and pagination filters) to find older ones.`
            : "All of them are listed below."
        }\n${recentMedicalDetails
          .map(
            (detail) =>
              `- ID: ${detail.id}, Summary: ${detail.summary}, Created: ${detail.created_at}`,
          )
          .join("\n")}`
      : `\n\nNo medical details currently in the system for ${personName}.`;

  // Get all people for system prompt with medical details count
  const allPeople = await db
    .select({
      id: personTable.id,
      firstName: personTable.firstName,
      lastName: personTable.lastName,
      notes: personTable.notes,
      isCreator: personTable.isCreator,
      creatorId: personTable.creatorId,
      createdAt: personTable.createdAt,
      medicalDetailsCount: count(medicalDetailTable.id),
    })
    .from(personTable)
    .leftJoin(
      medicalDetailTable,
      eq(personTable.id, medicalDetailTable.personId),
    )
    .where(eq(personTable.creatorId, session.user.id))
    .groupBy(personTable.id)
    .orderBy(asc(personTable.createdAt));

  const peopleContext =
    allPeople.length > 0
      ? `\n\nCurrent people in the system:\n${allPeople
          .map(
            (person) =>
              `- ID: ${person.id}, First Name: ${person.firstName}, Last Name: ${person.lastName}, Is Current User: ${person.isCreator}, Notes: ${person.notes || "None"}, Number of Medical Details: ${person.medicalDetailsCount}`,
          )
          .join("\n")}`
      : "\n\nNo people currently in the system.";

  const cacheControl = {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  };

  const modelMessages = await convertToModelMessages(messages);

  // Cache breakpoint on the conversation so far; prior turns are identical across requests
  const lastMessage = modelMessages.at(-1);
  if (lastMessage) lastMessage.providerOptions = cacheControl;

  // Volatile context goes after the breakpoint so it doesn't invalidate the cache
  modelMessages.push({
    role: "user",
    content: `<context>
      <medical_details_list>
      ${medicalDetailsContext}
      </medical_details_list>

      <people_list>
      ${peopleContext}
      </people_list>

      Today's date and time is ${new Date().toISOString()} in GMT and ${new Date().toLocaleString()} in the user's timezone.
      </context>`,
  });

  const result = streamText({
    model: anthropic("claude-opus-5-5"),
    messages: modelMessages,
    stopWhen: stepCountIs(8),
    system: {
      role: "system",
      providerOptions: cacheControl,
      content: `You are a medical expert with world class knowledge of medicine and the medical system including healthcare and insurance.
      You help users manage and analyze their medical situation. Your goal is to advocate for the user.
      You can list, read, create, update, and delete medical details in the database.

      Each medical detail has three text fields:
      1. summary: a brief one-line description, shown in lists.
      2. detailedNotes: your own thorough, well-organized write-up of the detail, including relevant context, interpretation, and anything useful for future reference.
      3. userRawContent: the user's own words, copied verbatim from their message(s), with no paraphrasing, summarizing, correcting, or reformatting. Include all of the user's text that relates to this detail. If the detail did not come from user-provided text (for example, you are recording a conclusion you reached), leave it empty.

      Use updateMedicalDetail to correct or add to an existing detail instead of creating a duplicate. Use deleteMedicalDetail when a detail is wrong, duplicated, or the user asks to remove it. Older details may have no userRawContent; that is expected.
      Do not include the current date and time in any field since it is recorded automatically.
      The people in the system and the most recent medical details for the current user are provided in the <context> block of the latest user message.
      To find other medical details (older ones, or for other people), use listMedicalDetailsForPerson with filters rather than fetching everything.

      Medical details are associated with a person. You can list and create people from the database.
      If there is not a person associated with the current user, prompt the user for their first name and last name
      so you can create a person for them.

      When users share their medical information or ask questions, use the appropriate tools to access or create medical details.
      Always be helpful and informative while being clear that you're providing a second opinion and not replacing professional medical advice.

      Be concise unless the user asks for more detail.

      Your responses are displayed as plain text, so do not use Markdown or any other markup.
      This means no headings, no bold or italic, no backticks or code blocks, no tables, no links in [text](url) form, and no bullet characters like "*" or "-".
      Write in short plain paragraphs separated by blank lines. If you need a list, use numbered lines like "1. " or put each item on its own line.

      <current_user_details>
      Full name: ${session.user.name}
      Email: ${session.user.email}
      </current_user_details>`,
    },

    tools: {
      listMedicalDetailsForPerson: tool({
        description:
          "List medical details for a person, with optional filtering and pagination. Returns ID, summary, and creation date for each match, plus the total number of matches. Use readMedicalDetail to get full content. If personId is not provided, defaults to the person associated with current user.",
        inputSchema: z.object({
          personId: z
            .number()
            .optional()
            .describe("The ID of the person to list medical details for"),
          startDate: z
            .string()
            .optional()
            .describe(
              "Only include details created on or after this date (ISO 8601, e.g. 2025-01-31 or 2025-01-31T14:00:00Z). Times are UTC.",
            ),
          endDate: z
            .string()
            .optional()
            .describe(
              "Only include details created on or before this date (ISO 8601). A date-only value includes that whole day. Times are UTC.",
            ),
          keyword: z
            .string()
            .optional()
            .describe(
              "Case-insensitive substring match against the summary, detailed notes, and user's raw content",
            ),
          order: z
            .enum(["newest", "oldest"])
            .optional()
            .describe("Sort by creation date. Defaults to newest first"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Max results to return (1-200). Defaults to 50"),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Number of results to skip, for pagination. Defaults to 0"),
        }),
        execute: async ({
          personId,
          startDate,
          endDate,
          keyword,
          order = "newest",
          limit = 50,
          offset = 0,
        }) => {
          const targetPersonId = personId ?? personForCurrentUser?.id;

          if (typeof targetPersonId !== "number") {
            return {
              error:
                "No person ID provided, and no default person associated with current user.",
            };
          }

          if (!(await isOwnedPerson(targetPersonId))) {
            return { error: `Person with ID ${targetPersonId} not found` };
          }

          const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
          // createdAt is stored as "YYYY-MM-DD HH:MM:SS" (UTC); datetime() normalizes both sides
          const conditions: SQL[] = [
            eq(medicalDetailTable.personId, targetPersonId),
          ];
          if (startDate) {
            conditions.push(
              sql`datetime(${medicalDetailTable.createdAt}) >= datetime(${startDate})`,
            );
          }
          if (endDate) {
            conditions.push(
              isDateOnly(endDate)
                ? sql`datetime(${medicalDetailTable.createdAt}) < datetime(${endDate}, '+1 day')`
                : sql`datetime(${medicalDetailTable.createdAt}) <= datetime(${endDate})`,
            );
          }
          if (keyword?.trim()) {
            const pattern = `%${keyword.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            conditions.push(
              or(
                sql`${medicalDetailTable.summary} LIKE ${pattern} ESCAPE '\\'`,
                sql`${medicalDetailTable.detailedNotes} LIKE ${pattern} ESCAPE '\\'`,
                sql`${medicalDetailTable.userRawContent} LIKE ${pattern} ESCAPE '\\'`,
              )!,
            );
          }
          const where = and(...conditions);

          const [details, [{ total }]] = await Promise.all([
            db
              .select({
                id: medicalDetailTable.id,
                summary: medicalDetailTable.summary,
                personId: medicalDetailTable.personId,
                createdAt: medicalDetailTable.createdAt,
              })
              .from(medicalDetailTable)
              .where(where)
              .orderBy(
                order === "oldest"
                  ? asc(medicalDetailTable.createdAt)
                  : desc(medicalDetailTable.createdAt),
                order === "oldest"
                  ? asc(medicalDetailTable.id)
                  : desc(medicalDetailTable.id),
              )
              .limit(limit)
              .offset(offset),
            db
              .select({ total: count() })
              .from(medicalDetailTable)
              .where(where),
          ]);

          return {
            medicalDetails: details,
            count: details.length,
            totalMatches: total,
            offset,
            hasMore: offset + details.length < total,
          };
        },
      }),

      createMedicalDetail: tool({
        description:
          "Create a new medical detail. Do not include the current date and time in any field since it is recorded automatically.",
        inputSchema: z.object({
          personId: z
            .number()
            .describe(
              "The ID of the person the medical detail is associated with",
            ),
          summary: z
            .string()
            .describe("Brief one-line summary of the medical detail"),
          detailedNotes: z
            .string()
            .describe(
              "Your thorough, well-organized write-up of the medical detail",
            ),
          userRawContent: z
            .string()
            .optional()
            .describe(
              "The user's own words about this detail, copied verbatim with no paraphrasing or reformatting. Omit if the detail did not come from user-provided text.",
            ),
        }),
        execute: async ({ personId, summary, detailedNotes, userRawContent }) => {
          if (!(await isOwnedPerson(personId))) {
            return { error: `Person with ID ${personId} not found` };
          }

          const [newDetail] = await db
            .insert(medicalDetailTable)
            .values({
              personId,
              summary,
              detailedNotes,
              userRawContent: userRawContent || null,
              creatorId: session.user.id,
            })
            .returning();

          return newDetail;
        },
      }),

      updateMedicalDetail: tool({
        description:
          "Update an existing medical detail. Only the fields you provide are changed; each provided field fully replaces the old value, so include the complete new text (not just the changes). Read the detail first if you need its current content.",
        inputSchema: z.object({
          id: z.number().describe("The ID of the medical detail to update"),
          personId: z
            .number()
            .optional()
            .describe("Move the detail to a different person"),
          summary: z
            .string()
            .optional()
            .describe("New brief one-line summary"),
          detailedNotes: z
            .string()
            .optional()
            .describe("New complete detailed notes"),
          userRawContent: z
            .string()
            .optional()
            .describe(
              "New complete verbatim user text. When the user adds more information to an existing detail, append their new words verbatim to the existing userRawContent.",
            ),
        }),
        execute: async ({ id, personId, ...fields }) => {
          if (!(await getOwnedDetail(id))) {
            return { error: `Medical detail with ID ${id} not found` };
          }
          if (personId !== undefined && !(await isOwnedPerson(personId))) {
            return { error: `Person with ID ${personId} not found` };
          }

          const updates = Object.fromEntries(
            Object.entries({ personId, ...fields }).filter(
              ([, value]) => value !== undefined,
            ),
          );
          if (Object.keys(updates).length === 0) {
            return { error: "No fields provided to update" };
          }

          const [updated] = await db
            .update(medicalDetailTable)
            .set({ ...updates, updatedAt: sql`CURRENT_TIMESTAMP` })
            .where(eq(medicalDetailTable.id, id))
            .returning();

          return updated;
        },
      }),

      deleteMedicalDetail: tool({
        description:
          "Permanently delete a medical detail by its ID. Use when a detail is wrong, duplicated, or the user asks to remove it.",
        inputSchema: z.object({
          id: z.number().describe("The ID of the medical detail to delete"),
        }),
        execute: async ({ id }) => {
          const detail = await getOwnedDetail(id);
          if (!detail) {
            return { error: `Medical detail with ID ${id} not found` };
          }

          await db
            .delete(medicalDetailTable)
            .where(eq(medicalDetailTable.id, id));

          return { deleted: true, id, summary: detail.summary };
        },
      }),

      readMedicalDetail: tool({
        description: "Read a specific medical detail by its ID",
        inputSchema: z.object({
          id: z.number().describe("The ID of the medical detail to read"),
        }),
        execute: async ({ id }) => {
          const detail = await getOwnedDetail(id);

          if (!detail) {
            return {
              error: `Medical detail with ID ${id} not found`,
            };
          }

          return detail;
        },
      }),

      listPeople: tool({
        description: "List all people with their IDs, names, and notes",
        inputSchema: z.object({}),
        execute: async () => {
          const people = await db
            .select({
              id: personTable.id,
              firstName: personTable.firstName,
              lastName: personTable.lastName,
              notes: personTable.notes,
              isCurrentUser: personTable.isCreator,
              createdAt: personTable.createdAt,
            })
            .from(personTable)
            .where(eq(personTable.creatorId, session.user.id));

          return {
            people: people,
            count: people.length,
          };
        },
      }),

      createPerson: tool({
        description:
          "Create a new person with first name, last name, notes, and optionally mark as current user",
        inputSchema: z.object({
          firstName: z.string().describe("First name of the person"),
          lastName: z.string().describe("Last name of the person"),
          notes: z.string().describe("Notes about the person"),
          isCurrentUser: z
            .boolean()
            .optional()
            .describe(
              "Whether this person is the current user (defaults to false)",
            ),
        }),
        execute: async ({ firstName, lastName, notes, isCurrentUser }) => {
          const [newPerson] = await db
            .insert(personTable)
            .values({
              firstName,
              lastName,
              notes,
              isCreator: isCurrentUser,
              creatorId: session.user.id,
            })
            .returning();

          return newPerson;
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
