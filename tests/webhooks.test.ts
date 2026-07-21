import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTwilioRequestSignature,
  handleInboundSmsWebhook,
  handleStatusCallbackWebhook,
  type TwilioWebhookAccount,
} from "../src/webhooks.ts";
import {
  listRecentOutboundSmsStatuses,
  resetTwilioSmsStateForTests,
} from "../src/state.ts";

const account: TwilioWebhookAccount = {
  authToken: "secret",
  publicBaseUrl: "https://example.com",
  webhookPath: "/twilio-sms/webhook",
  statusCallbackPath: "/twilio-sms/status",
};

function signedHeaders(path: string, form: URLSearchParams): Record<string, string> {
  const url = new URL(path, account.publicBaseUrl).toString();
  return {
    "x-twilio-signature": buildTwilioRequestSignature(account.authToken, url, form),
  };
}

function requestFromForm(form: URLSearchParams, headers = signedHeaders(account.webhookPath, form)) {
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      yield form.toString();
    },
  };
}

function responseRecorder() {
  const headers = new Map<string, string>();
  return {
    statusCode: undefined as number | undefined,
    body: undefined as string | undefined,
    headers,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end(body?: string) {
      this.body = body;
    },
  };
}

test("inbound webhook accepts valid Twilio signature and dispatches once", async () => {
  resetTwilioSmsStateForTests();
  const form = new URLSearchParams({
    From: "+15551111111",
    To: "+15550000000",
    Body: "hello",
    MessageSid: "SM_INBOUND_VALID",
  });
  const res = responseRecorder();
  const dispatched: unknown[] = [];

  await handleInboundSmsWebhook({
    req: requestFromForm(form),
    res,
    account,
    processInbound: async (payload) => {
      dispatched.push(payload);
    },
  });
  await Promise.resolve();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "<Response></Response>");
  assert.equal(res.headers.get("Content-Type"), "text/xml");
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], {
    from: "+15551111111",
    to: "+15550000000",
    body: "hello",
    messageSid: "SM_INBOUND_VALID",
  });
});

test("inbound webhook acknowledges duplicate MessageSid without dispatching again", async () => {
  resetTwilioSmsStateForTests();
  const form = new URLSearchParams({
    From: "+15551111111",
    To: "+15550000000",
    Body: "hello",
    MessageSid: "SM_INBOUND_DUPLICATE",
  });
  const dispatched: unknown[] = [];

  await handleInboundSmsWebhook({
    req: requestFromForm(form),
    res: responseRecorder(),
    account,
    processInbound: async (payload) => {
      dispatched.push(payload);
    },
  });
  await handleInboundSmsWebhook({
    req: requestFromForm(form),
    res: responseRecorder(),
    account,
    processInbound: async (payload) => {
      dispatched.push(payload);
    },
  });
  await Promise.resolve();

  assert.equal(dispatched.length, 1);
});

test("inbound webhook rejects invalid Twilio signature without dispatching", async () => {
  resetTwilioSmsStateForTests();
  const form = new URLSearchParams({
    From: "+15551111111",
    To: "+15550000000",
    Body: "hello",
    MessageSid: "SM_INBOUND_BAD_SIG",
  });
  const res = responseRecorder();
  let dispatched = false;

  await handleInboundSmsWebhook({
    req: requestFromForm(form, { "x-twilio-signature": "bad-signature" }),
    res,
    account,
    processInbound: async () => {
      dispatched = true;
    },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body, "<Response></Response>");
  assert.equal(dispatched, false);
});

test("status callback stores valid delivery status", async () => {
  resetTwilioSmsStateForTests();
  const form = new URLSearchParams({
    MessageSid: "SM_STATUS_DELIVERED",
    To: "+15551111111",
    From: "+15550000000",
    MessageStatus: "delivered",
  });
  const res = responseRecorder();

  await handleStatusCallbackWebhook({
    req: requestFromForm(form, signedHeaders(account.statusCallbackPath, form)),
    res,
    account,
    now: 1_234,
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.body, undefined);
  assert.deepEqual(listRecentOutboundSmsStatuses(), [
    {
      sid: "SM_STATUS_DELIVERED",
      to: "+15551111111",
      from: "+15550000000",
      status: "delivered",
      errorCode: null,
      errorMessage: null,
      updatedAt: 1_234,
    },
  ]);
});

test("status callback ignores missing SID cleanly", async () => {
  resetTwilioSmsStateForTests();
  const form = new URLSearchParams({
    MessageStatus: "delivered",
  });
  const res = responseRecorder();

  await handleStatusCallbackWebhook({
    req: requestFromForm(form, signedHeaders(account.statusCallbackPath, form)),
    res,
    account,
  });

  assert.equal(res.statusCode, 204);
  assert.deepEqual(listRecentOutboundSmsStatuses(), []);
});

test("status callback rejects invalid Twilio signature", async () => {
  resetTwilioSmsStateForTests();
  const form = new URLSearchParams({
    MessageSid: "SM_STATUS_BAD_SIG",
    MessageStatus: "failed",
  });
  const res = responseRecorder();

  await handleStatusCallbackWebhook({
    req: requestFromForm(form, { "x-twilio-signature": "bad-signature" }),
    res,
    account,
  });

  assert.equal(res.statusCode, 403);
  assert.deepEqual(listRecentOutboundSmsStatuses(), []);
});
