import { db } from "~/db";
import { personTable } from "~/db/schema";
import { eq, and } from "drizzle-orm";

export async function getPersonForUser(userId: string): Promise<typeof personTable.$inferSelect | null> {
  const results = await db.select().from(personTable).where(and(eq(personTable.creatorId, userId), eq(personTable.isCreator, true)));
  return results[0] || null;
}