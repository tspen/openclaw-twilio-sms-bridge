import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateSmsParts,
  isRetryableTwilioStatus,
  normalizeSmsText,
  sendTwilioSms,
  splitSmsText,
  TwilioSmsSendError,
} from "../src/client.ts";
import { markInboundSmsSeen } from "../src/state.ts";

test("normalizeSmsText keeps SMS output plain ASCII", () => {
  assert.equal(
    normalizeSmsText("  \u201cHello\u201d\u2014Tim\u2026\u00a0\n\n\n\u{1f680}  "),
    '"Hello"-Tim...',
  );
});

test("splitSmsText drops empty messages after normalization", () => {
  assert.deepEqual(splitSmsText("   \u{1f680}   "), []);
  assert.deepEqual(splitSmsText("  ok  "), ["ok"]);
});

test("estimateSmsParts follows GSM single and multipart segment sizes", () => {
  assert.equal(estimateSmsParts(""), 0);
  assert.equal(estimateSmsParts("a".repeat(160)), 1);
  assert.equal(estimateSmsParts("a".repeat(161)), 2);
  assert.equal(estimateSmsParts("a".repeat(307)), 3);
});

test("isRetryableTwilioStatus only retries transient failures", () => {
  assert.equal(isRetryableTwilioStatus(408), true);
  assert.equal(isRetryableTwilioStatus(429), true);
  assert.equal(isRetryableTwilioStatus(500), true);
  assert.equal(isRetryableTwilioStatus(503), true);
  assert.equal(isRetryableTwilioStatus(400), false);
  assert.equal(isRetryableTwilioStatus(401), false);
  assert.equal(isRetryableTwilioStatus(404), false);
});

test("sendTwilioSms retries transient failures and sends status callback", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: URLSearchParams[] = [];
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    bodies.push(init?.body as URLSearchParams);
    if (calls === 1) {
      return new Response("temporary", { status: 503 });
    }
    return Response.json({ sid: "SM123" });
  }) as typeof fetch;

  try {
    const result = await sendTwilioSms(
      {
        accountSid: "AC123",
        authToken: "secret",
        fromNumber: "+15550000000",
        statusCallbackUrl: "https://example.com/twilio-sms/status",
      },
      "+15551111111",
      "hello",
      { maxAttempts: 2, retryDelayMs: 0 },
    );

    assert.equal(result.sid, "SM123");
    assert.equal(calls, 2);
    assert.equal(bodies[0].get("StatusCallback"), "https://example.com/twilio-sms/status");
    assert.equal(bodies[1].get("To"), "+15551111111");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendTwilioSms does not retry permanent Twilio failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        sendTwilioSms(
          {
            accountSid: "AC123",
            authToken: "secret",
            fromNumber: "+15550000000",
          },
          "+15551111111",
          "hello",
          { maxAttempts: 3, retryDelayMs: 0 },
        ),
      (error: unknown) => {
        assert.equal(error instanceof TwilioSmsSendError, true);
        assert.equal((error as TwilioSmsSendError).status, 400);
        assert.equal((error as TwilioSmsSendError).retryable, false);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("markInboundSmsSeen suppresses duplicate MessageSid values", () => {
  assert.equal(markInboundSmsSeen("SM_DUPLICATE_TEST", 1_000), false);
  assert.equal(markInboundSmsSeen("SM_DUPLICATE_TEST", 1_001), true);
  assert.equal(markInboundSmsSeen("SM_DUPLICATE_TEST", 1_000 + 25 * 60 * 60 * 1000), false);
});
