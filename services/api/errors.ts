import type { errorCodes } from "../../packages/contracts/access";

export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code: typeof errorCodes[number], message: string) {
    super(message);
  }
}

export function accessRequired(): ApiError {
  return new ApiError(403, "TEST_ACCESS_REQUIRED", "请先兑换有效的测试邀请");
}
