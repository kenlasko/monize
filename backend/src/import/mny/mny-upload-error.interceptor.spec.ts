import { ExecutionContext, PayloadTooLargeException } from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import { MnyUploadErrorInterceptor } from "./mny-upload-error.interceptor";

describe("MnyUploadErrorInterceptor", () => {
  const context = {} as ExecutionContext;
  const tooLarge = () =>
    throwError(() => new PayloadTooLargeException("File too large"));

  it("replaces multer's size error with the Money sentence by default", async () => {
    const interceptor = new MnyUploadErrorInterceptor(50);

    const error = await lastValueFrom(
      interceptor.intercept(context, { handle: tooLarge }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PayloadTooLargeException);
    expect((error as PayloadTooLargeException).getResponse()).toMatchObject({
      message: "That Money file is larger than the 50 MB import limit.",
      errorCode: "mnyFileTooLarge",
    });
  });

  it("uses the exception factory it is given", async () => {
    const factory = jest.fn(
      (limitMb: number) => new PayloadTooLargeException(`custom ${limitMb}`),
    );
    const interceptor = new MnyUploadErrorInterceptor(25, factory);

    const error = await lastValueFrom(
      interceptor.intercept(context, { handle: tooLarge }),
    ).catch((e: unknown) => e);

    expect(factory).toHaveBeenCalledWith(25);
    expect((error as PayloadTooLargeException).message).toBe("custom 25");
  });

  it("passes other errors and values through", async () => {
    const interceptor = new MnyUploadErrorInterceptor(50);
    const boom = new Error("boom");

    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => boom),
        }),
      ),
    ).rejects.toBe(boom);
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => of(1) })),
    ).resolves.toBe(1);
  });
});
