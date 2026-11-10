// The frizz.sh guide exists twice: docs/remote-access.md, and the page the homepage links,
// site/docs/frizz-sh.html. site/README.md says to change them together, and for four days nobody did:
// on 2026-11-10 the page had none of what the Markdown says about what a signed-in device can do, and
// its Relay term stopped before "anyone who took control of the relay could do the same". Those are
// the sentences someone deciding whether to turn a frizz.sh subdomain on needs to read.
//
// So the sentences that carry that decision are held to both files, word for word. The rest of the
// two documents is free to differ: the page is a guide for one option, the Markdown covers five.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

const repo = dirname(import.meta.dirname);

/** Prose as a reader sees it: no markup, no Markdown emphasis or code marks, one space between words. */
function prose(text) {
  return text
    // An inline tag sits inside a sentence (`(<code>.env</code>, a key`); only a block ends one.
    .replace(/<\/?(code|strong|kbd|em|a|span)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\*\*|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ");
}
const markdown = prose(readFileSync(join(repo, "docs", "remote-access.md"), "utf8"));
const page = prose(readFileSync(join(repo, "site", "docs", "frizz-sh.html"), "utf8"));

const IN_BOTH = [
  // What each level of access is.
  "A few things stay on that computer for every device:",
  "minting a sign-in link;",
  "listing the devices that hold a session, or signing another one out;",
  "changing what a device signed in through frizz.sh can do.",
  "reads the board and answers question cards by picking a listed option. Everything else happens on the computer running Frizz:",
  "starting or steering a thread, or changing its settings;",
  "answering a free-text, secret or danger card;",
  "approving or denying an action a worker is waiting on;",
  "restarts and updates;",
  "reading a file outside a registered project or a thread's scratch and attachment directories, or a secret-looking file inside one (.env, a key, anything under a dotted folder other than .frizz).",
  "The new answer applies to devices already signed in.",
  "A refused call is written to logs/audit.jsonl under Frizz's data folder, with the session and device that made it.",
  // What the relay is trusted with.
  "Every request and keystroke passes through a relay Frizz runs, and the sign-in check runs on your machine.",
  "A device with full control can run anything on your machine.",
  "The relay carries that traffic, so anyone who took control of the relay could do the same.",
  "Under read and answer, they could read the board and pick options on cards.",
  // Who can end a session.
  "Sign out this device in Settings ends that browser's session and nothing else.",
  "a stolen phone cannot sign out the laptop.",
  // Where the key that owns the name is.
  "Copy the key file to another machine to move the subdomain.",
  "The file is identity.key, in ~/Library/Application Support/Frizz on macOS and ~/.local/state/frizz on Linux.",
];

test("what a signed-in device and the relay can do reads the same in the guide and on the site", () => {
  const lower = (text) => text.toLowerCase();
  const missing = IN_BOTH.flatMap((sentence) => [
    ...(lower(markdown).includes(lower(sentence)) ? [] : [`docs/remote-access.md lacks: ${sentence}`]),
    ...(lower(page).includes(lower(sentence)) ? [] : [`site/docs/frizz-sh.html lacks: ${sentence}`]),
  ]);
  assert.deepEqual(missing, [], "change the two together (site/README.md)");
});

test("both name the commands that list and end sessions", () => {
  for (const command of ["npx frizz --link", "npx frizz --sessions", "npx frizz --sign-out all"]) {
    assert.ok(markdown.includes(command), `docs/remote-access.md does not show ${command}`);
    assert.ok(page.includes(command.replace("npx frizz ", "$ npx frizz ")) || page.includes(command), `site/docs/frizz-sh.html does not show ${command}`);
  }
});
