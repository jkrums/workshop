import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Admin-only manual trigger for the Hermes daily briefing. The actual run
// dispatch needs the heartbeat service, which is constructed after createApp
// (and only when heartbeatSchedulerEnabled). We accept a holder that index.ts
// populates once the service is available.
export interface DailyBriefingRunnerHolder {
  run: (() => Promise<void>) | null;
}

export function dailyBriefingRoutes(_db: Db, holder: DailyBriefingRunnerHolder) {
  const router = Router();

  router.post("/routines/daily-briefing/run-now", async (req, res) => {
    if (req.actor.type !== "board") {
      res.status(401).json({ error: "user authentication required" });
      return;
    }
    if (!holder.run) {
      res
        .status(503)
        .json({ error: "daily briefing scheduler is not enabled on this instance" });
      return;
    }
    try {
      await holder.run();
      logger.info(
        { userId: req.actor.userId },
        "daily briefing triggered manually via /run-now",
      );
      res.status(202).json({ status: "dispatched" });
    } catch (err) {
      logger.error({ err }, "manual daily briefing trigger failed");
      res.status(500).json({ error: "daily briefing dispatch failed" });
    }
  });

  return router;
}
