import pino from "pino";
import { config } from "../config";

export const log = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
});
