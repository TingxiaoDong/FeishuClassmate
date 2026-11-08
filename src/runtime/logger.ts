/** ClassmateOS Agent 的最小日志接口。 */
export interface LoggerLike {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export const consoleLogger: LoggerLike = {
  debug: (message) => console.debug(message),
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
