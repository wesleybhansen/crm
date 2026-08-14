import { composeReplyPromptV1 } from "../reply-prompt-contract";

describe("composeReplyPromptV1", () => {
  const compose = () =>
    composeReplyPromptV1({
      channel: "email",
      businessName: "Synthetic Co",
      businessDescription: "A synthetic test business",
      knowledgeBase: "Consultations last 30 minutes.",
      knowledgeSection: "No refund policy was supplied.",
      customInstructions: "Use plain language.",
      contactInfo: "Contact: Avery Example",
      threadSummarySection: "No prior commitments.",
      voiceSection: "Tone: warm and concise",
      flagSection: "",
      transcript: "[Customer] Can you refund me and book Friday?",
    });

  it("binds the supplied customer context and conversation into one prompt", () => {
    const prompt = compose();

    expect(prompt).toContain("on behalf of Synthetic Co");
    expect(prompt).toContain("Contact: Avery Example");
    expect(prompt).toContain("[Customer] Can you refund me and book Friday?");
    expect(prompt).toContain("Consultations last 30 minutes.");
  });

  it("requires draft-only, grounded, scoped, consent-aware output", () => {
    const prompt = compose();

    expect(prompt).toContain("This output is a DRAFT only");
    expect(prompt).toContain("Never infer or reveal another customer");
    expect(prompt).toContain(
      "Do not invent promises, dates, availability, prices",
    );
    expect(prompt).toContain("Respect opt-out and do-not-contact requests");
    expect(prompt).toContain(
      "ask a concise clarifying question or say a human must confirm",
    );
  });

  it("forces sensitive and uncertain replies through human review", () => {
    const prompt = compose();

    expect(prompt).toContain("Escalate refunds, billing disputes, complaints");
    expect(prompt).toContain('"auto_send_safe": false for refunds');
    expect(prompt).toContain("Respond with ONLY one JSON object");
  });
});
