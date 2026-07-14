import { DrizzleLearningStore } from "./drizzle-store";
import { LearningService } from "./service";

export const learningService = new LearningService({
  store: new DrizzleLearningStore(),
});
