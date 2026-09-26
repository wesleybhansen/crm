import { expect, test } from '@playwright/test';
import { createCompanyFixture, createDealFixture, createPipelineFixture, createPipelineStageFixture, deleteEntityIfExists, deleteEntityByBody } from '@open-mercato/core/modules/core/__integration__/helpers/crmFixtures';
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api';
import { login } from '@open-mercato/core/modules/core/__integration__/helpers/auth';

/**
 * TC-CRM-009: Update Deal Pipeline Stage
 * Source: .ai/qa/scenarios/TC-CRM-009-deal-pipeline-update.md
 */
test.describe('TC-CRM-009: Update Deal Pipeline Stage', () => {
  test('should update a deal pipeline stage to Won and reflect it in the pipeline board', async ({ page, request }) => {
    let token: string | null = null;
    let companyId: string | null = null;
    let dealId: string | null = null;
    let pipelineId: string | null = null;
    let openStageId: string | null = null;
    let winStageId: string | null = null;

    const companyName = `QA TC-CRM-009 Co ${Date.now()}`;
    const dealTitle = `QA TC-CRM-009 Deal ${Date.now()}`;
    const pipelineName = `QA TC-CRM-009 Pipeline ${Date.now()}`;

    try {
      token = await getAuthToken(request);
      await login(page, 'admin');

      // The app's pipeline board (apps/mercato .../deals/pipeline) replaces
      // the core multi-pipeline board: it has no pipeline picker and lays out
      // one lane per stage name from the workspace's business profile
      // (built-in defaults when none is set), placing each open deal by its
      // stage label. Name the fixture stages after lanes that board shows.
      const profile = await page.evaluate(async () => {
        const res = await fetch('/api/customers/business-profile', { credentials: 'include' });
        const body = await res.json().catch(() => null);
        return (body?.data ?? null) as { pipeline_mode?: string | null; pipeline_stages?: unknown } | null;
      });
      expect(profile?.pipeline_mode ?? 'deals', 'the pipeline board must be in deals mode').toBe('deals');
      let boardStages = ['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];
      const rawStages = typeof profile?.pipeline_stages === 'string'
        ? JSON.parse(profile.pipeline_stages)
        : profile?.pipeline_stages;
      if (Array.isArray(rawStages) && rawStages.length >= 2) {
        boardStages = rawStages
          .map((stage: unknown) => (typeof stage === 'string' ? stage : (stage as { name?: string })?.name))
          .filter((name): name is string => typeof name === 'string' && name.length > 0);
      }
      const openLabel = boardStages[0];
      const winLabel = boardStages.find((name) => /^won$/i.test(name));
      expect(winLabel, `the pipeline board has a Won lane (lanes: ${boardStages.join(', ')})`).toBeTruthy();

      companyId = await createCompanyFixture(request, token, companyName);
      pipelineId = await createPipelineFixture(request, token, { name: pipelineName });
      openStageId = await createPipelineStageFixture(request, token, { pipelineId, label: openLabel, order: 0 });
      winStageId = await createPipelineStageFixture(request, token, { pipelineId, label: winLabel!, order: 1 });
      dealId = await createDealFixture(request, token, {
        title: dealTitle,
        companyIds: [companyId],
        pipelineId,
        pipelineStageId: openStageId,
      });

      await page.goto(`/backend/customers/deals/${dealId}`);

      // Select the Won stage — scope to the CrudForm field wrapper to avoid
      // collisions with the status select, which also lists Won/Lost.
      // Wait for enabled: the select is disabled until pipeline stages load.
      const pipelineStageSelect = page.locator('[data-crud-field-id="pipelineStageId"] select');
      await expect(pipelineStageSelect).toBeEnabled();
      await pipelineStageSelect.selectOption(winStageId!);
      await page.getByRole('button', { name: /Update deal/i }).click();
      // Assert the saved stage, not visible text: the stage name also
      // appears as hidden <option>s (stage and status selects).
      await expect
        .poll(async () => {
          const res = await apiRequest(
            request,
            'GET',
            `/api/customers/deals?pipelineStageId=${encodeURIComponent(winStageId!)}&pageSize=100`,
            { token: token! },
          );
          if (!res.ok()) return `status ${res.status()}`;
          const body = (await res.json()) as { items?: Array<{ id?: string }> };
          return (body.items ?? []).some((item) => item.id === dealId) ? 'moved' : 'not yet';
        }, { timeout: 15_000 })
        .toBe('moved');

      // The board shows the deal in the Won lane: its card is visible and
      // the card's move-select reports the lane it sits in.
      await page.goto('/backend/customers/deals/pipeline');
      await expect(page.getByText(dealTitle, { exact: true })).toBeVisible();
      await expect(page.getByLabel(`Move ${dealTitle} to stage`)).toHaveValue(winLabel!);
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/deals', dealId);
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId);
      await deleteEntityByBody(request, token, '/api/customers/pipeline-stages', winStageId);
      await deleteEntityByBody(request, token, '/api/customers/pipeline-stages', openStageId);
      await deleteEntityByBody(request, token, '/api/customers/pipelines', pipelineId);
    }
  });
});
