import { SharedReviewService } from "../shared-review.service";

/** No integrated group, so the model payload is unchanged. */
export function sharedReviewMock() {
  return { annotate: jest.fn(async (_userId: string, data: unknown) => data) };
}
export function sharedReviewProvider() {
  return { provide: SharedReviewService, useValue: sharedReviewMock() };
}
