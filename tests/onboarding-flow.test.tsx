import express from "express";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.js";
import { createApi } from "../server/api.js";
import { disableSampleFilters } from "../shared/profile-filters.js";
import { defaultRecommendationPrompts } from "../shared/recommendations.js";
import {
  localBrowserStatus,
  readAnonymousPage,
} from "../server/local-browser.js";
import {
  RecommendationWeek,
  RejectedRecommendationList,
} from "../src/Recommendations.js";

const execute = promisify(execFile);

it.skipIf(!localBrowserStatus().available)(
  "completes a new Romanian-speaking user's web + Telegram selection through local tools, review, publication and calendar rendering",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "activity-onboarding-flow-"));
    const database = join(directory, "new-user.sqlite");
    const store = new Store(database),
      app = express();
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing port");
      app.use(createApi(store, address.port));
      const base = `http://127.0.0.1:${address.port}/api`;
      const request = async (
        path: string,
        body?: unknown,
        method = body ? "POST" : "GET",
      ) => {
        const response = await fetch(base + path, {
          method,
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await response.json();
        if (!response.ok) throw Error(JSON.stringify(data));
        return data;
      };
      const bootstrap = await request("/bootstrap");
      expect(bootstrap.entities).toHaveLength(0);
      const scope = bootstrap.scopes.find(
        (item: { id: string }) => item.id === "chisinau",
      );
      const { updatedAt: _, ...profile } = bootstrap.profile;
      profile.summary =
        "Locuiesc în Chișinău. Vorbesc moldovenește/română și engleză.";
      profile.musicPreferences = [
        "Muzică locală și concerte în română; îmi plac și tribute bands.",
      ];
      profile.artists = [];
      profile.additionalPreferences =
        "Limba română/moldovenească și engleza sunt potrivite. Fără prioritate sau includere automată pentru limba rusă. Accept artiști locali și tribute bands.";
      profile.automaticFilters = disableSampleFilters(profile.automaticFilters);
      profile.excludedTelegramChannels = [];
      profile.recommendationPrompts = {
        ...defaultRecommendationPrompts,
        concerts:
          "Concerte locale în română sau engleză, inclusiv tribute bands.",
      };
      await request("/profile", profile, "PUT");
      const savedProfile = await request("/profile");
      expect(savedProfile.additionalPreferences).toBe(
        profile.additionalPreferences,
      );
      expect((await request("/filter-rules")).rules.eventTitle.enabled).toBe(
        false,
      );
      expect(
        (await request("/telegram-monitoring/settings")).settings
          .excludedChannels,
      ).toEqual([]);
      const prepared = await request("/recommendations/prepare-sources", {
        scopeId: scope.id,
      });
      expect(prepared.channels.length).toBeGreaterThan(0);
      const channel = prepared.channels[0];
      const view = await request("/recommendations?scopeId=chisinau&kind=week");

      // Real local transport/CLI and MCP schema, with a bounded synthetic worker:
      // no owner session or Telegram network is available to this test.
      const worker = join(directory, "synthetic-python");
      writeFileSync(
        worker,
        `#!${process.execPath}
const fs=require('node:fs');
const request=JSON.parse(fs.readFileSync(0,'utf8'));
fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({command:process.argv.at(-1),channels:request.channels})+'\\n');
const channels=request.channels.map((target,index)=>({channel:{id:String(index+1),username:target,title:target,url:'https://t.me/'+target,broadcast:true,megagroup:false,verified:false,participantsCount:500},posts:[{id:'10',text:'Întâlnire de conversație în limba română. Eveniment deschis pentru adulți, cu participare în grup, loc și înscriere confirmate.',date:process.env.FIXTURE_PUBLISHED,editDate:null,url:'https://t.me/'+target+'/10',authorSignature:null,senderId:null,viaBotId:null,groupedId:null,replyToMessageId:null,replyToTopId:null,isPost:true,isForwarded:false,isReply:false,isPinned:false,isSilent:false,noForwards:false,views:100,forwards:0,replyCount:0,reactionCount:0,reactions:[],media:null,entities:[],hashtags:[],mentions:[],links:[],buttons:[],forward:null,restrictionReasons:[],signals:{hasText:true,hasMedia:false,hasExternalLink:false,hasTelegramLink:false,hasPrice:false,hasPromoLanguage:false,hasAdDisclosure:false}}],scannedCount:1,returnedCount:1,filteredCount:0,filterBreakdown:{},truncated:false,nextBeforeMessageId:null}));
console.log(JSON.stringify({ok:true,requestCount:channels.length,channels,range:{startDate:request.startDate,endDate:request.endDate,timeZone:request.timeZone},warnings:[],billing:{perResultUsd:0,paidStarsAllowed:false,note:'Synthetic transport'}}));
`,
        { mode: 0o700 },
      );
      const input = join(directory, "telegram-input.json"),
        output = join(directory, "telegram-output.json");
      writeFileSync(
        input,
        JSON.stringify({
          channels: [channel.username],
          startDate: view.period.startDate,
          endDate: view.period.endDate,
          timeZone: scope.timezone,
          maxPostsPerChannel: 10,
          maxScannedPerChannel: 10,
          pageSize: 10,
          delaySeconds: 5,
        }),
      );
      await execute(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/local-tool.ts",
          "telegram",
          "telegram_monitoring_posts",
          "--input",
          input,
          "--output",
          output,
        ],
        {
          cwd: resolve(import.meta.dirname, ".."),
          env: {
            ...process.env,
            ACTIVITY_DB: database,
            TELEGRAM_API_ID: "123",
            TELEGRAM_API_HASH: "synthetic-test-hash-not-owner-0000",
            TELEGRAM_PYTHON: worker,
            TELEGRAM_SESSION_PATH: join(directory, "no-session"),
            FIXTURE_PUBLISHED: new Date().toISOString(),
            FIXTURE_TRACE: join(directory, "trace"),
          },
        },
      );
      const monitoring = JSON.parse(readFileSync(output, "utf8"));
      expect(monitoring.channels[0].posts).toHaveLength(1);
      const context = await request("/telegram-events/review-context");
      const tgReview = await request("/telegram-events/review", {
        startDate: view.period.startDate,
        endDate: view.period.endDate,
        expectedProfileFingerprint: context.profileFingerprint,
        monitoring,
        selections: [
          {
            communityId: channel.communityId,
            postId: "10",
            activityKey: "romanian-meetup",
            title: "Întâlnire în română",
            startAt: view.period.endDate,
            endAt: "",
            country: scope.country,
            city: scope.city,
            venue: "Test",
            relevanceScore: 9,
            relevanceReason: "Limbă și format potrivite profilului nou.",
            validationNotes: "Sursă sintetică într-o bază izolată.",
          },
        ],
        channelReviews: [],
      });
      expect(tgReview.savedCount).toBe(1);

      const rendered = await readAnonymousPage(
        {
          action: "read",
          url: "https://example.org/calendar",
          maxChars: 3000,
          waitMs: 100,
        },
        async () =>
          new Response(
            `<html><title>Calendar local</title><body><h1 id="event"></h1><script>document.querySelector('#event').textContent='Concert local în română · Tribute';</script><script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: "Concert local în română · Tribute", startDate: view.period.endDate, url: "https://example.org/concert", description: "Programă locală în limba română." })}</script></body></html>`,
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
      );
      expect(rendered.text).toContain("Concert local în română");
      const event = JSON.parse(rendered.jsonLd[0]);
      const imported = await request("/import", {
        entities: [
          {
            type: "Event",
            title: event.name,
            description: event.description,
            startAt: event.startDate,
            url: event.url,
            country: scope.country,
            city: scope.city,
          },
        ],
      });
      expect(imported.result.created).toBe(1);
      expect(imported.result.filtered).toBe(0); // The owner's 'tribute' filter is off.
      const tgCard = {
        title: "Întâlnire în română",
        description: "Conversație și întâlnire în grup.",
        startAt: view.period.endDate,
        endAt: "",
        aiScore: 9,
        sourceName: channel.title,
        sourceUrl: `https://t.me/${channel.username}/10`,
        eventUrl: "",
        group: "social",
        tags: [],
      };
      const webCard = {
        ...tgCard,
        title: event.name,
        description: event.description,
        aiScore: 8,
        sourceName: "Calendar local",
        sourceUrl: "https://example.org/calendar",
        eventUrl: event.url,
        group: "concerts",
      };
      const rejected = {
        ...webCard,
        title: "Program fără legătură cu interesele mele",
        eventUrl: "https://example.org/other",
        aiScore: 2,
        rejectionReason:
          "Tema nu corespunde intereselor; limba nu este motivul respingerii.",
      };
      const filtered = await request("/recommendations/filter-candidates", {
        scopeId: scope.id,
        candidates: [tgCard, webCard, rejected],
      });
      expect(filtered.candidates).toHaveLength(3);
      const snapshotId = randomUUID();
      await request("/recommendations", {
        id: snapshotId,
        scopeId: scope.id,
        kind: "week",
        ...view.period,
        settingsRevision: view.settings.revision,
        expectedSnapshotId: null,
        requestSummary: "Recomandări pentru profilul propriu",
        notes: "Offline transport fixtures; no live provider collection.",
        items: [tgCard, webCard],
        rejectedItems: [rejected],
      });
      const final = await request(
        "/recommendations?scopeId=chisinau&kind=week",
      );
      expect(final.snapshot.id).toBe(snapshotId);
      expect(final.snapshot.items).toHaveLength(2);
      expect(final.rejected).toHaveLength(1);
      const calendar = renderToStaticMarkup(
        <RecommendationWeek
          items={final.snapshot.items}
          today={view.period.startDate}
          timeZone={scope.timezone}
        />,
      );
      expect(calendar).toContain("Concert local în română");
      expect(calendar).toContain("Întâlnire în română");
      expect(
        renderToStaticMarkup(
          <RejectedRecommendationList
            items={final.rejected}
            timeZone={scope.timezone}
          />,
        ),
      ).toContain(rejected.rejectionReason);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);
