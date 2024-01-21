import Inibase from "./index.js";
import { parentPort, workerData } from "node:worker_threads";

const { _constructor, functionName, arg } = workerData;
// @ts-ignore
new Inibase(..._constructor)
  [functionName](...arg)
  .then((res: any) => parentPort?.postMessage(res));
