"use client";

import { useTranslations } from "next-intl";
import { SharedAmount } from "./SharedPrimitives";

/** The direction belongs beside the amount, rather than being encoded only by its sign. */
export function SharedPositionValue({
  amount,
  currency,
  personal = false,
  prominent = false,
  hideCaption = false,
}: {
  amount: string | null;
  currency: string;
  personal?: boolean;
  prominent?: boolean;
  hideCaption?: boolean;
}) {
  const t = useTranslations("sharedExpenses");
  const number = amount === null ? null : Number(amount);
  const caption = sharedPositionCaption(amount, personal);
  return (
    <div>
      {!hideCaption && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t(caption)}</p>
      )}
      <p className={prominent ? "mt-1 text-2xl font-semibold" : "font-medium"}>
        <SharedAmount
          amount={number === null ? null : String(Math.abs(number))}
          currency={currency}
        />
      </p>
    </div>
  );
}

export function sharedPositionCaption(
  amount: string | null,
  personal: boolean,
) {
  const number = amount === null ? null : Number(amount);
  return number === null
    ? personal
      ? "yourBalance"
      : "positions"
    : number === 0
      ? "settled"
      : number > 0
        ? personal
          ? "overallReceivable"
          : "getsBack"
        : personal
          ? "overallPayable"
          : "owes";
}
