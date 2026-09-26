import { Migration } from '@mikro-orm/migrations'

/* Lost deals are 'lost', and deals parked in a Won/Lost stage carry that status (2026-09-29).
 *
 * 1. The deal status dictionary stored Lost as 'loose' (and the assistant
 *    wrote 'lose'), while reports counted only 'lose'/'lost': every deal
 *    marked Lost in the deal form was invisible to them and the win rate was
 *    inflated. Writers now store 'lost' (lib/dealStatus canonicalDealStatus);
 *    this renames the existing deals and the 'deal_status' dictionary entry
 *    (or drops the 'loose' entry where the organization already has 'lost').
 * 2. Dragging a deal into the Won or Lost column of the pipeline board set
 *    only its stage and left it 'open', so reports never counted it and the
 *    board kept it in the open pipeline value. The board now sets the status
 *    on the move; this gives the same status to open deals already sitting
 *    in a stage named exactly Won / Closed Won or Lost / Closed Lost.
 *
 * updated_at is left alone so none of this reads as new activity in the
 * 30/90-day report windows. No event is emitted (history, not a close).
 * Neither column is encrypted. Row-local updates, so tenant-agnostic;
 * idempotent; missing tables are skipped. down() is a no-op: 'lost' rows
 * written after this cannot be told apart from renamed ones. */
export class Migration20260929120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.customer_deals') IS NULL THEN
    RAISE NOTICE 'skip: table customer_deals does not exist';
    RETURN;
  END IF;
  UPDATE public.customer_deals SET status = 'lost'
   WHERE status IN ('loose', 'lose');
  UPDATE public.customer_deals SET status = 'win'
   WHERE status = 'open'
     AND lower(trim(pipeline_stage)) IN ('won', 'closed won');
  UPDATE public.customer_deals SET status = 'lost'
   WHERE status = 'open'
     AND lower(trim(pipeline_stage)) IN ('lost', 'closed lost');
END $$;`)

    this.addSql(`DO $$
BEGIN
  IF to_regclass('public.customer_dictionary_entries') IS NULL THEN
    RAISE NOTICE 'skip: table customer_dictionary_entries does not exist';
    RETURN;
  END IF;
  UPDATE public.customer_dictionary_entries e
     SET value = 'lost', normalized_value = 'lost', updated_at = now()
   WHERE e.kind = 'deal_status' AND e.normalized_value = 'loose'
     AND NOT EXISTS (
       SELECT 1 FROM public.customer_dictionary_entries o
        WHERE o.organization_id = e.organization_id AND o.tenant_id = e.tenant_id
          AND o.kind = 'deal_status' AND o.normalized_value = 'lost'
     );
  DELETE FROM public.customer_dictionary_entries e
   WHERE e.kind = 'deal_status' AND e.normalized_value = 'loose'
     AND EXISTS (
       SELECT 1 FROM public.customer_dictionary_entries o
        WHERE o.organization_id = e.organization_id AND o.tenant_id = e.tenant_id
          AND o.kind = 'deal_status' AND o.normalized_value = 'lost'
     );
END $$;`)
  }

  override async down(): Promise<void> {
    // Renamed rows cannot be told apart from 'lost' rows written since.
  }
}
