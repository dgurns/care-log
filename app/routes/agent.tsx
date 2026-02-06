import type { Route } from "./+types/agent";
import { streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { db } from "~/db";
import { medicalDetailTable, personTable } from "~/db/schema";
import { eq, desc, asc, count } from "drizzle-orm";
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

  // Get all medical details for current user
  const allMedicalDetails = personForCurrentUser
    ? await db
        .select({
          id: medicalDetailTable.id,
          summary: medicalDetailTable.summary,
          person_id: medicalDetailTable.personId,
          created_at: medicalDetailTable.createdAt,
        })
        .from(medicalDetailTable)
        .where(eq(medicalDetailTable.personId, personForCurrentUser.id))
        .orderBy(desc(medicalDetailTable.createdAt))
    : [];

  const medicalDetailsContext =
    allMedicalDetails.length > 0
      ? `\n\nCurrent medical details in the system for ${personForCurrentUser?.firstName} ${personForCurrentUser?.lastName}:\n${allMedicalDetails
          .map(
            (detail) =>
              `- ID: ${detail.id}, Summary: ${detail.summary}, Created: ${detail.created_at}`,
          )
          .join("\n")}`
      : `\n\nNo medical details currently in the system for ${personForCurrentUser?.firstName} ${personForCurrentUser?.lastName}.`;

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

  const modelMessages = await convertToModelMessages(messages);
  const result = streamText({
    model: anthropic("claude-opus-4-6"),
    messages: modelMessages,
    stopWhen: stepCountIs(8),
    system: `You are a medical expert with world class knowledge of medicine and the medical system including healthcare and insurance. 
      You help users manage and analyze their medical situation. Your goal is to advocate for the user. 
      You can list, create, and read medical details from the database.
      
      <medical_details_list>
      ${medicalDetailsContext}
      </medical_details_list>

      Medical details are associated with a person. You can list and create people from the database. 
      If there is not a person associated with the current user, prompt the user for their first name and last name
      so you can create a person for them. 

      <people_list>
      ${peopleContext}
      </people_list>

      When users share their medical information or ask questions, use the appropriate tools to access or create medical details. 
      Always be helpful and informative while being clear that you're providing a second opinion and not replacing professional medical advice.

      Be concise unless the user asks for more detail.

      <current_user_details>
      Full name: ${session.user.name}
      Email: ${session.user.email}
      </current_user_details>
      
      Today's date and time is ${new Date().toISOString()} in GMT and ${new Date().toLocaleString()} in the user's timezone.`,

    tools: {
      listMedicalDetailsForPerson: tool({
        description:
          "List all medical details for a person. Returns ID, summary, and creation date for each medical detail. If person_id is not provided, defaults to the person associated with current user.",
        inputSchema: z.object({
          personId: z
            .number()
            .optional()
            .describe("The ID of the person to list medical details for"),
        }),
        execute: async ({ personId }) => {
          let targetPersonId = personId ?? personForCurrentUser?.id;

          if (typeof targetPersonId !== "number") {
            return {
              error:
                "No person ID provided, and no default person associated with current user.",
            };
          }

          const details = await db
            .select({
              id: medicalDetailTable.id,
              summary: medicalDetailTable.summary,
              personId: medicalDetailTable.personId,
              createdAt: medicalDetailTable.createdAt,
            })
            .from(medicalDetailTable)
            .where(eq(medicalDetailTable.personId, targetPersonId))
            .orderBy(desc(medicalDetailTable.createdAt));

          return {
            medicalDetails: details,
            count: details.length,
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
          const [detail] = await db
            .select()
            .from(medicalDetailTable)
            .where(eq(medicalDetailTable.id, id));

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
