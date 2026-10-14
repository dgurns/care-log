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
      You can list, create, and read medical details from the database.
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
              "Case-insensitive substring match against the summary and full content",
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

          // Ensure the person belongs to the current user
          const [person] = await db
            .select({ id: personTable.id })
            .from(personTable)
            .where(
              and(
                eq(personTable.id, targetPersonId),
                eq(personTable.creatorId, session.user.id),
              ),
            );
          if (!person) {
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
                sql`${medicalDetailTable.fullRawContent} LIKE ${pattern} ESCAPE '\\'`,
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
          "Create a new medical detail with summary and raw content. Do not include the current date and time in summary or full_raw_content since it will be automatically recorded.",
        inputSchema: z.object({
          personId: z
            .number()
            .describe(
              "The ID of the person the medical detail is associated with",
            ),
          summary: z.string().describe("Brief summary of the medical detail"),
          fullRawContent: z
            .string()
            .describe("Full raw content of the medical detail"),
        }),
        execute: async ({ personId, summary, fullRawContent }) => {
          const [newDetail] = await db
            .insert(medicalDetailTable)
            .values({
              personId,
              summary,
              fullRawContent,
              creatorId: session.user.id,
            })
            .returning();

          return newDetail;
        },
      }),

      readMedicalDetail: tool({
        description: "Read a specific medical detail by its ID",
        inputSchema: z.object({
          id: z.number().describe("The ID of the medical detail to read"),
        }),
        execute: async ({ id }) => {
          // Only allow reading details for people the current user created
          const [row] = await db
            .select({ detail: medicalDetailTable })
            .from(medicalDetailTable)
            .innerJoin(
              personTable,
              eq(medicalDetailTable.personId, personTable.id),
            )
            .where(
              and(
                eq(medicalDetailTable.id, id),
                eq(personTable.creatorId, session.user.id),
              ),
            );
          const detail = row?.detail;

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
