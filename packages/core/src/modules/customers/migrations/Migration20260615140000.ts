import { Migration } from '@mikro-orm/migrations';

export class Migration20260615140000 extends Migration {

  override async up(): Promise<void> {
    // Customer Service feature: website chat as a support channel.
    // cs_chat_enabled gates whether the public website chat widget routes each
    // inbound visitor message through the Customer Service drafter (flag
    // scenarios + grounding) instead of the existing standalone widget bot.
    //   false (default) -> chat behaves exactly as today (the widget bot answers).
    //   true            -> each inbound visitor message is drafted by the CS
    //                      engine. No scenario match auto-answers instantly; a
    //                      flagged scenario whose action is 'auto_send' sends the
    //                      scenario-instructed reply; any 'pause' scenario (pause
    //                      wins) posts a brief holding message to the visitor and
    //                      queues a flagged CS proposal for human review + emails
    //                      the org user an alert.
    // Nullable boolean defaulting to false. Idempotent: safe to re-run on the box.
    this.addSql(`
      DO $$ BEGIN
        ALTER TABLE "customer_service_settings"
          ADD COLUMN "cs_chat_enabled" boolean not null default false;
      EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DO $$ BEGIN ALTER TABLE "customer_service_settings" DROP COLUMN "cs_chat_enabled"; EXCEPTION WHEN undefined_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`);
  }

}
