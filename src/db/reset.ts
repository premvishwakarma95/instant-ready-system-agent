/**
 * Clears local operational data (CallAttempt, Quote) for a fresh test run —
 * dev-only. WebhookResponse (raw MDR capture) is left in place — that's the
 * real data we're inspecting to rebuild against, not test noise.
 *
 * Usage: npm run db:reset
 */
import { connectDB, disconnectDB } from "./connection.js";
import { CallAttempt, Quote } from "./models/index.js";

async function main() {
  await connectDB();

  const [attempts, quotes] = await Promise.all([CallAttempt.deleteMany({}), Quote.deleteMany({})]);

  console.log(`Cleared ${attempts.deletedCount} call attempts and ${quotes.deletedCount} quotes.`);

  await disconnectDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
