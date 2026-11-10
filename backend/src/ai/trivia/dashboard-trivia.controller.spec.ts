import { DashboardTriviaController } from "./dashboard-trivia.controller";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { ALLOW_DELEGATE_KEY } from "../../delegation/decorators/delegate-access.decorator";

describe("DashboardTriviaController", () => {
  it("reads the signed-in user's list", async () => {
    const list = {
      items: [],
      figures: {},
      generatedAt: "2026-11-09T00:00:00Z",
    };
    const service = { getTrivia: jest.fn().mockResolvedValue(list) };
    const controller = new DashboardTriviaController(
      service as unknown as DashboardTriviaService,
    );
    await expect(controller.getTrivia({ user: { id: "u1" } })).resolves.toBe(
      list,
    );
    expect(service.getTrivia).toHaveBeenCalledWith("u1");
  });

  it("is closed to a delegate", () => {
    expect(
      Reflect.getMetadata(
        ALLOW_DELEGATE_KEY,
        DashboardTriviaController.prototype.getTrivia,
      ),
    ).toBeUndefined();
  });
});
