export class DaySpending {
  dayOfWeek: number; // 0=Sun, 6=Sat
  total: number;
  count: number;
}

export class CategoryWeekendWeekday {
  categoryId: string | null;
  categoryName: string;
  weekendTotal: number;
  weekdayTotal: number;
}

export class WeekendWeekdaySummary {
  weekendTotal: number;
  weekdayTotal: number;
  weekendCount: number;
  weekdayCount: number;
}

export class WeekendVsWeekdayResponse {
  summary: WeekendWeekdaySummary;
  byDay: DaySpending[];
  byCategory: CategoryWeekendWeekday[];
}
