// Two-browser end-to-end run: map -> request -> accept -> chat -> video -> block.
// Mapbox network calls are stubbed (empty style) so DOM markers + the GeoJSON
// arc layer render without a real token.
//
// Usage (dev server running with ANY pk.* token, e.g. NEXT_PUBLIC_MAPBOX_TOKEN=pk.fake):
//   npm i --no-save playwright-core        # uses your installed Google Chrome
//   node scripts/e2e.mjs [screenshotDir]   # headless; set SKIP_VIDEO=1 to skip video
//   HEADED=1 node scripts/e2e.mjs          # needed for the video steps: headless
//                                          # Chrome's fake camera never resolves
// Wait ~20s between runs so the previous run's users expire (15s stale window).
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = process.argv[2] ?? join(tmpdir(), "pulse-e2e");
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.HEADED !== "1",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const STYLE = {
  version: 8,
  name: "stub",
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b1020" } }],
};

async function user(lat, lng, label) {
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 760 },
    geolocation: { latitude: lat, longitude: lng },
    permissions: ["geolocation", "camera", "microphone"],
  });
  // REAL_MAPBOX=1 uses the real basemap (needs the dev server started with a
  // real NEXT_PUBLIC_MAPBOX_TOKEN); otherwise Mapbox is stubbed.
  if (process.env.REAL_MAPBOX !== "1") {
    await ctx.route(/mapbox\.com/, (route) => {
      const url = route.request().url();
      if (url.includes("/styles/v1/")) {
        return route.fulfill({ json: STYLE });
      }
      return route.fulfill({ status: 204, body: "" });
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.label = label;
  page.errors = errors;
  await page.goto(BASE);
  await page.getByRole("button", { name: "Put me on the map" }).click();
  await page.locator(".pulse-me").waitFor({ timeout: 20000 });
  return page;
}

const A = await user(14.6, 121.0, "A");
const B = await user(14.62, 121.03, "B");
const C = await user(14.58, 120.98, "C");

check("map screen loads with 'You' pin", (await A.locator(".pulse-me").count()) === 1);
await A.locator(".pulse-dot").first().waitFor({ timeout: 15000 });
await B.locator(".pulse-dot").first().waitFor({ timeout: 15000 });
await A.waitForFunction(() => document.querySelectorAll(".pulse-dot").length >= 2, null, { timeout: 10000 }).catch(() => {});
check("A sees the other lights", (await A.locator(".pulse-dot").count()) >= 2);
await A.waitForTimeout(3500); // let the glide-in finish
await A.screenshot({ path: `${OUT}/01-map.png` });

// --- request -> accept ------------------------------------------------------
// A's dots: pick the one that is B by trying until B shows the prompt.
const dotsA = A.locator(".pulse-dot");
const total = await dotsA.count();
let requested = false;
for (let i = 0; i < total && !requested; i++) {
  // Test users sit a few km apart, so their lights overlap at this zoom;
  // dispatch the click to the element itself instead of by coordinates.
  await dotsA.nth(i).dispatchEvent("click");
  try {
    await B.getByRole("alertdialog").waitFor({ timeout: 4000 });
    requested = true;
  } catch {
    // That was C; cancel and try next.
    await A.getByRole("button", { name: "Cancel" }).click();
    await C.getByRole("alertdialog").waitFor({ timeout: 4000 });
    await C.getByRole("button", { name: "Not now" }).click();
    await A.waitForTimeout(1800);
  }
}
check("B gets 'Someone wants to say hello'", requested);
check("A shows waiting state", await A.getByText("Waiting for them to answer").isVisible());
await B.screenshot({ path: `${OUT}/02-incoming.png` });
await B.getByRole("button", { name: "Accept" }).click();

await A.getByText("Connected, just the two of you").waitFor({ timeout: 25000 });
await B.getByText("Connected, just the two of you").waitFor({ timeout: 25000 });
check("both sides reach Connected (WebRTC data channel open)", true);

// --- chat -------------------------------------------------------------------
await A.getByLabel("Message").fill("hello from A");
await A.getByRole("button", { name: "Send" }).click();
await B.getByText("hello from A").waitFor({ timeout: 8000 });
check("B receives A's chat message", true);
await B.getByLabel("Message").fill("hi A, B here");
await B.getByRole("button", { name: "Send" }).click();
await A.getByText("hi A, B here").waitFor({ timeout: 8000 });
check("A receives B's chat message", true);
await A.screenshot({ path: `${OUT}/03-chat.png` });

// --- map arcs / busy state seen by a bystander ------------------------------
await C.waitForTimeout(2500);
const busyDots = await C.locator('.pulse-dot[data-busy="true"]').count();
check("bystander sees both talkers as busy", busyDots >= 2, `busy=${busyDots}`);
await C.mouse.move(550, 380);
for (let i = 0; i < 10; i++) {
  await C.mouse.wheel(0, -500);
  await C.waitForTimeout(120);
}
await C.waitForTimeout(1500);
await C.screenshot({ path: `${OUT}/04-bystander-arc.png` });

// --- video ------------------------------------------------------------------
const SKIP_VIDEO = process.env.SKIP_VIDEO === "1";
if (!SKIP_VIDEO) {
await A.getByRole("button", { name: "Ask to start a video call" }).click();
await B.getByText("Start a video call?").waitFor({ timeout: 8000 });
await B.getByRole("button", { name: "Accept" }).click();
try {
  await A.getByRole("button", { name: "End video" }).waitFor({ timeout: 15000 });
  await B.getByRole("button", { name: "End video" }).waitFor({ timeout: 15000 });
} catch (e) {
  for (const p of [A, B]) {
    console.log(`--- ${p.label} body text:`, (await p.locator("body").innerText()).slice(0, 400).replace(/\n+/g, " | "));
    console.log(`--- ${p.label} errors:`, p.errors.slice(-5));
    await p.screenshot({ path: `${OUT}/debug-${p.label}.png` });
    console.log(
      `--- ${p.label} gUM probe:`,
      await p.evaluate(() =>
        Promise.race([
          navigator.mediaDevices
            .getUserMedia({ video: true, audio: true })
            .then((s) => "ok tracks=" + s.getTracks().length)
            .catch((e) => "reject " + e.name + ": " + e.message),
          new Promise((r) => setTimeout(() => r("HANG >5s"), 5000)),
        ]),
      ),
    );
  }
  throw e;
}
check("both sides enter the video call", true);

const remoteOk = async (p) =>
  p.waitForFunction(
    () => {
      const v = document.querySelector('video[aria-label="Stranger\'s video"]');
      return !!v && v.videoWidth > 0 && v.readyState >= 2;
    },
    null,
    { timeout: 20000 },
  );
await remoteOk(A);
await remoteOk(B);
check("remote video frames arrive on both sides", true);

const blurred = (p) =>
  p.locator('video[aria-label="Stranger\'s video"]').evaluate((v) => v.className.includes("blur-3xl"));
check("remote video starts blurred", (await blurred(A)) && (await blurred(B)));
await A.screenshot({ path: `${OUT}/05-video-blurred.png` });
await A.getByRole("button", { name: "Show video" }).click();
await A.waitForTimeout(700);
check("'Show video' reveals it", !(await blurred(A)));
await A.screenshot({ path: `${OUT}/06-video-revealed.png` });
await A.getByRole("button", { name: "Blur video" }).click();
check("'Blur video' re-blurs it", await blurred(A));

await A.getByRole("button", { name: "Mute" }).click();
check("mute toggles", await A.getByRole("button", { name: "Unmute" }).isVisible());

await A.getByRole("button", { name: "End video" }).click();
await A.getByLabel("Message").waitFor({ timeout: 8000 });
await B.getByLabel("Message").waitFor({ timeout: 8000 });
check("ending video returns both to chat", true);
}

// --- block ------------------------------------------------------------------
await B.getByRole("button", { name: "More options" }).click();
await B.getByRole("button", { name: /Block this person/ }).click();
await B.screenshot({ path: `${OUT}/07-block-confirm.png` });
await B.getByRole("button", { name: "Block", exact: true }).click();
await A.getByText("Stranger disconnected.").waitFor({ timeout: 10000 });
check("blocked side is told the chat ended", true);
await A.waitForTimeout(2200);
const aDots = await A.locator(".pulse-dot").count();
const bDots = await B.locator(".pulse-dot").count();
check("block hides each from the other (A sees only C, B sees only C)", aDots === 1 && bDots === 1, `A=${aDots} B=${bDots}`);

// --- leave frees dots -------------------------------------------------------
await C.close();
await A.waitForTimeout(2500);
check("closing a tab removes its dot", (await A.locator(".pulse-dot").count()) === 0);

for (const p of [A, B]) {
  const errs = p.errors.filter((e) => !/mapbox|events|net::ERR|Failed to load resource/i.test(e));
  check(`no unexpected console errors (${p.label})`, errs.length === 0, errs.slice(0, 3).join(" | "));
}
await browser.close();
console.log(failures === 0 ? "\nE2E ALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
