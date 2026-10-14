import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { db } from "~/db";
import { dailyBriefTable, medicalDetailTable, personTable } from "~/db/schema";
import { eq, desc, and, gte } from "drizzle-orm";

export async function getDailyBriefForToday(
  personForCurrentUser: typeof personTable.$inferSelect,
): Promise<typeof dailyBriefTable.$inferSelect | null> {
  const today = new Date().toISOString().split("T")[0];
  const existingBrief = await db
    .select()
    .from(dailyBriefTable)
    .where(
      and(
        eq(dailyBriefTable.personId, personForCurrentUser.id),
        gte(dailyBriefTable.createdAt, today),
      ),
    )
    .limit(1);

  if (existingBrief.length > 0) {
    return existingBrief[0];
  }
  return null;
}

export type PersonDailyBrief = {
  person: typeof personTable.$inferSelect;
  brief: typeof dailyBriefTable.$inferSelect | null;
  generatingPromise: Promise<typeof dailyBriefTable.$inferSelect> | null;
};

// Resolve the daily brief for a single person: return today's brief if it
// already exists, otherwise kick off generation (only if there are recent
// medical details), otherwise return nothing.
export async function getOrGenerateDailyBrief(
  person: typeof personTable.$inferSelect,
): Promise<PersonDailyBrief> {
  const existingBrief = await getDailyBriefForToday(person);
  if (existingBrief) {
    return { person, brief: existingBrief, generatingPromise: null };
  }

  // Check for recent medical details in past 7 days. If none, don't generate
  // a daily brief.
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoISOString = sevenDaysAgo.toISOString();

  const recentMedicalDetails = await db
    .select()
    .from(medicalDetailTable)
    .where(
      and(
        eq(medicalDetailTable.personId, person.id),
        gte(medicalDetailTable.createdAt, sevenDaysAgoISOString),
      ),
    )
    .limit(1);

  if (recentMedicalDetails.length === 0) {
    return { person, brief: null, generatingPromise: null };
  }

  return { person, brief: null, generatingPromise: generateDailyBrief(person) };
}

// Resolve daily briefs for every person created by the given user (the user
// themself as well as any people they've added).
export async function getDailyBriefsForUser(
  userId: string,
): Promise<PersonDailyBrief[]> {
  const people = await db
    .select()
    .from(personTable)
    .where(eq(personTable.creatorId, userId));

  return Promise.all(people.map((person) => getOrGenerateDailyBrief(person)));
}

export async function generateDailyBrief(
  personForCurrentUser: typeof personTable.$inferSelect,
) {
  // Get all medical details for current user
  const allMedicalDetails = await db
    .select({
      id: medicalDetailTable.id,
      summary: medicalDetailTable.summary,
      fullRawContent: medicalDetailTable.fullRawContent,
      createdAt: medicalDetailTable.createdAt,
    })
    .from(medicalDetailTable)
    .where(eq(medicalDetailTable.personId, personForCurrentUser.id))
    .orderBy(desc(medicalDetailTable.createdAt));

  const medicalDetailsContext =
    allMedicalDetails.length > 0
      ? allMedicalDetails
          .map(
            (detail) =>
              `Summary: ${detail.summary}\nFull Content: ${detail.fullRawContent}\nDate: ${detail.createdAt}`,
          )
          .join("\n\n")
      : "No medical details available.";

  // Generate daily brief using AI
  const { text } = await generateText({
    model: anthropic("claude-haiku-5-5"),
    system: `You are a medical expert creating a daily brief for ${personForCurrentUser.firstName} ${personForCurrentUser.lastName}. 
        Based on their medical details, provide a daily brief with actionable recommendations for today. 
        Focus on what they should prioritize, monitor, or follow up on today. Keep it practical and personalized.
        
        <medical_details>
        ${medicalDetailsContext}
        </medical_details>

        <rules>
        - The daily brief **MUST** be 1 sentence.
        - Do not include a header or title - only return the brief itself.
        </rules>

        Today's date: ${new Date().toLocaleDateString()}`,
    prompt: "Create the daily brief based on the medical details provided.",
  });

  // Save daily brief to database
  const [newBrief] = await db
    .insert(dailyBriefTable)
    .values({
      personId: personForCurrentUser.id,
      brief: text,
      creatorId: personForCurrentUser.creatorId,
    })
    .returning();

  return newBrief;
}
