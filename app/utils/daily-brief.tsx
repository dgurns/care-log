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
    model: anthropic("claude-sonnet-4-5"),
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
