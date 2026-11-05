import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  type DeviceCodePrompt,
  FRIZZ_GITHUB_CLIENT_ID,
  GITHUB_CLIENT_ID_PLACEHOLDER,
  githubClientId,
  GithubSignInError,
  runDeviceFlow,
} from "./github-device-flow.ts";

/**
 * A stand-in for github.com and api.github.com on one loopback port, answering the device flow from a
 * script. Every request is recorded with its decoded form body, so a test can assert what the launcher
 * actually put on the wire — above all that it never asked for a scope.
 */
async function fakeGithub(script: {
  device?: { status?: number; body: Record<string, unknown> };
  polls: Array<Record<string, unknown>>;
  user?: Record<string, unknown>;
}) {
  const requests: Array<{ method: string; path: string; form: Record<string, string>; authorization?: string }> = [];
  let poll = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      requests.push({ method: req.method!, path: req.url!, form, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/login/device/code") {
        return send(script.device?.status ?? 200, script.device?.body ?? {
          device_code: "dev-123",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }
      if (req.url === "/login/oauth/access_token") return send(200, script.polls[poll++] ?? { error: "authorization_pending" });
      if (req.url === "/user") return send(200, script.user ?? { login: "ada", id: 1 });
      send(404, { message: "Not Found" });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    requests,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

/** A clock the flow's own sleeps advance, so a 15-minute expiry is tested in milliseconds. */
function fakeTime() {
  let now = 1_800_000_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

function flow(github: { origin: string }, time: ReturnType<typeof fakeTime>, prompts: DeviceCodePrompt[] = []) {
  return runDeviceFlow({
    clientId: "Iv1.testclient",
    githubOrigin: github.origin,
    apiOrigin: github.origin,
    now: time.now,
    sleep: time.sleep,
    onPrompt: (prompt) => prompts.push(prompt),
  });
}

test("pending, then slow_down, then a zero-scope token: the code is shown once and the interval is obeyed", async () => {
  const github = await fakeGithub({
    polls: [
      { error: "authorization_pending" },
      { error: "slow_down", interval: 10 },
      { access_token: "gho_zeroscope", token_type: "bearer", scope: "" },
    ],
  });
  const time = fakeTime();
  const prompts: DeviceCodePrompt[] = [];
  try {
    const result = await flow(github, time, prompts);
    assert.deepEqual(result, { token: "gho_zeroscope", login: "ada" });
    assert.equal(prompts.length, 1, "the code is shown exactly once");
    assert.equal(prompts[0]!.userCode, "WDJB-MJHT");
    assert.equal(prompts[0]!.verificationUri, "https://github.com/login/device");
    // GitHub's interval, then the longer one slow_down named — ignoring it gets the client throttled.
    assert.deepEqual(time.sleeps, [5000, 5000, 10000]);

    const start = github.requests[0]!;
    assert.equal(start.path, "/login/device/code");
    assert.deepEqual(start.form, { client_id: "Iv1.testclient" }, "no scope is ever requested");
    const polls = github.requests.filter((r) => r.path === "/login/oauth/access_token");
    assert.equal(polls.length, 3);
    for (const poll of polls) {
      assert.deepEqual(poll.form, {
        client_id: "Iv1.testclient",
        device_code: "dev-123",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    }
    const user = github.requests.find((r) => r.path === "/user");
    assert.equal(user?.authorization, "Bearer gho_zeroscope", "the login is read with the new token, not a gh one");
  } finally {
    await github.close();
  }
});

test("slow_down with no interval adds GitHub's five seconds", async () => {
  const github = await fakeGithub({ polls: [{ error: "slow_down" }, { access_token: "gho_x", scope: "" }] });
  const time = fakeTime();
  try {
    await flow(github, time);
    assert.deepEqual(time.sleeps, [5000, 10000]);
  } finally {
    await github.close();
  }
});

test("a code nobody enters expires, by GitHub's word or by the clock", async () => {
  const told = await fakeGithub({ polls: [{ error: "authorization_pending" }, { error: "expired_token" }] });
  try {
    await assert.rejects(flow(told, fakeTime()), (error: unknown) => error instanceof GithubSignInError && error.code === "expired");
  } finally {
    await told.close();
  }

  // GitHub never says so here: the flow stops at expires_in on its own rather than polling forever.
  const silent = await fakeGithub({
    device: { body: { device_code: "d", user_code: "AAAA-BBBB", verification_uri: "https://github.com/login/device", expires_in: 12, interval: 5 } },
    polls: [],
  });
  const time = fakeTime();
  try {
    await assert.rejects(flow(silent, time), /expired before it was entered/);
    assert.equal(silent.requests.filter((r) => r.path === "/login/oauth/access_token").length, 2, "two polls fit in 12s at 5s");
  } finally {
    await silent.close();
  }
});

test("a declined sign-in is refused, and no claim follows", async () => {
  const github = await fakeGithub({ polls: [{ error: "access_denied" }] });
  try {
    await assert.rejects(flow(github, fakeTime()), (error: unknown) => error instanceof GithubSignInError && error.code === "denied");
    assert.equal(github.requests.some((r) => r.path === "/user"), false);
  } finally {
    await github.close();
  }
});

test("a token GitHub granted a scope on is never handed back", async () => {
  // The app asks for none, so this means something is wrong — and the registrar would refuse it anyway.
  const github = await fakeGithub({ polls: [{ access_token: "gho_powerful", scope: "repo,workflow" }] });
  try {
    await assert.rejects(flow(github, fakeTime()), (error: unknown) => error instanceof GithubSignInError && error.code === "scoped");
    assert.equal(github.requests.some((r) => r.path === "/user"), false, "the scoped token is not even used to read the login");
  } finally {
    await github.close();
  }
});

test("GitHub refusing to start the flow says why", async () => {
  const github = await fakeGithub({
    device: { body: { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" } },
    polls: [],
  });
  try {
    await assert.rejects(flow(github, fakeTime()), /Device Flow must be explicitly enabled/);
  } finally {
    await github.close();
  }
});

test("escape cancels the wait", async () => {
  const github = await fakeGithub({ polls: [] });
  const abort = new AbortController();
  try {
    const pending = runDeviceFlow({
      clientId: "Iv1.testclient",
      githubOrigin: github.origin,
      apiOrigin: github.origin,
      signal: abort.signal,
      onPrompt: () => abort.abort(),
    });
    await assert.rejects(pending, (error: unknown) => error instanceof GithubSignInError && error.code === "cancelled");
  } finally {
    await github.close();
  }
});

test("while the client id is the placeholder, a sign-in refuses before touching the network", async () => {
  let called = false;
  await assert.rejects(
    runDeviceFlow({
      clientId: githubClientId({ FRIZZ_GITHUB_CLIENT_ID: GITHUB_CLIENT_ID_PLACEHOLDER }),
      onPrompt: () => {},
      fetchImpl: (async () => {
        called = true;
        throw new Error("no network");
      }) as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof GithubSignInError && error.code === "not-configured" && /private frizz\.sh subdomain needs no account/.test(error.message),
  );
  assert.equal(called, false);
  assert.equal(githubClientId({ FRIZZ_GITHUB_CLIENT_ID: GITHUB_CLIENT_ID_PLACEHOLDER }), null);
  assert.equal(githubClientId({}), FRIZZ_GITHUB_CLIENT_ID === GITHUB_CLIENT_ID_PLACEHOLDER ? null : FRIZZ_GITHUB_CLIENT_ID);
  assert.equal(githubClientId({ FRIZZ_GITHUB_CLIENT_ID: " Iv1.override " }), "Iv1.override", "the env override wins");
});
