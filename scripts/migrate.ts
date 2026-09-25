import { Store } from "../server/store.js";
import { config } from "dotenv";
config({ path: ".env.local" });
const store = new Store(
  process.env.ACTIVITY_DB || "../data/activity-checker/activity.sqlite",
);
console.log("SQLite: migrations и каталог источников готовы.");
store.close();
