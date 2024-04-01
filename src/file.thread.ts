import { parentPort, workerData } from "node:worker_threads";
import * as File from "./file.js";

const { functionName, arg } = workerData;
// @ts-ignore
File[functionName](...arg).then((res) => parentPort.postMessage(res));
