import { kmyAccount } from "../__fixtures__/kmy-xml-builders";
import type { KmyRawFile } from "../model/kmy-raw";
import { KmyRawCollector } from "./kmy-raw-collector";
import { tokenizeKmyXml } from "./kmy-xml-tokenize";

export function collect(xml: string): KmyRawFile {
  const collector = new KmyRawCollector();
  tokenizeKmyXml(Buffer.from(xml, "utf8"), collector);
  return collector.finish("xml");
}

export const checking = kmyAccount();
export const category = kmyAccount({
  id: "A000002",
  parentaccount: "AStd::Expense",
  type: 13,
  name: "Food",
});
