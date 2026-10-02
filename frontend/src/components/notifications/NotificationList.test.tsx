import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@/test/render';
import { NotificationList } from './NotificationList';
import { NO_NOTIFICATION_FILTERS } from '@/lib/notification-filters';
import type { Notification } from '@/types/notification';
import { usePreferencesStore } from '@/store/preferencesStore';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/budgets',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** A `YYYY-MM-DD` date `offset` days from today, on the local clock. */
const daysFromToday = (offset: number): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * The same `YYYY-MM-DD` rendered under the `DD.MM.YYYY` preference the date
 * tests set -- what the reader sees instead of the raw stored ISO. Kept as a
 * plain string reshuffle so the assertion cannot pass by echoing the component's
 * own formatter.
 */
const asUserDate = (ymd: string): string => {
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
};

const makeNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'notification-1',
  userId: 'user-1',
  budgetId: 'budget-1',
  budgetCategoryId: 'bc-1',
  type: 'THRESHOLD_WARNING',
  severity: 'warning',
  title: 'Groceries reaching budget limit',
  message: 'You have used 85% of your Groceries budget.',
  data: {},
  isRead: false,
  isEmailSent: false,
  periodStart: '2026-02-01',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('NotificationList', () => {
  const defaultProps = {
    notifications: [] as Notification[],
    isLoading: false,
    onMarkRead: vi.fn(),
    onMarkAllRead: vi.fn(),
    onDismiss: vi.fn(),
    onUndoDismiss: vi.fn(),
    dismissingIds: new Set<string>(),
    collapsingIds: new Set<string>(),
    onClose: vi.fn(),
    filters: NO_NOTIFICATION_FILTERS,
    onFiltersChange: vi.fn(),
    onDeleteAll: vi.fn(),
  };

  it('links to the active reminders page and closes the panel', () => {
    render(<NotificationList {...defaultProps} />);
    const link = screen.getByRole('link', { name: 'Active reminders' });
    expect(link).toHaveAttribute('href', '/reminders');
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('hides reminder management when the caller is a delegate', () => {
    render(<NotificationList {...defaultProps} canManageNotifications={false} />);
    expect(screen.queryByRole('link', { name: 'Active reminders' })).not.toBeInTheDocument();
  });

  it('lets a delegate open a row without changing read state or exposing write controls', () => {
    render(<NotificationList {...defaultProps} canManageNotifications={false}
      notifications={[makeNotification(), makeNotification({ id: 'nag', data: { reminderId: 'rem-1' } })]} />);
    for (const id of ['mark-all-read', 'delete-all-notifications', 'dismiss-notification-notification-1',
      'remind-me-notification-1', 'stop-reminder-nag']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('notification-item-notification-1'));
    expect(defaultProps.onMarkRead).not.toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-1');
  });

  it('renders structured security price facts and navigates to the instrument', () => {
    render(<NotificationList {...defaultProps} notifications={[makeNotification({
      type: 'SECURITY_PRICE_MOVEMENT', title: 'stored English', message: 'stored English',
      target: '/securities/sec-1', data: { symbol: 'AAPL', changePercent: -5.25 },
    })]} />);
    expect(screen.getByText('Price change alert: AAPL (-5.25%)')).toBeInTheDocument();
    expect(screen.getByText('AAPL: -5.25% compared with the previous available session.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('notification-item-notification-1'));
    expect(mockPush).toHaveBeenCalledWith('/securities/sec-1');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // A due date on a notification row is a calendar string; the UI must render
    // it in the reader's own date-format preference, never the stored ISO. The
    // date tests below pin a concrete, non-browser pattern so the expected
    // output is the same on every CI locale.
    usePreferencesStore.setState({
      preferences: { dateFormat: 'DD.MM.YYYY' } as never,
    });
  });

  afterEach(() => {
    // `cleanup()` first: vitest runs after-hooks in reverse registration order,
    // so a store write here would re-render the still-mounted tree outside act
    // (`src/test/test-hygiene.test.ts`).
    cleanup();
    usePreferencesStore.setState({ preferences: null });
  });

  // The one string on every row, and the one the rename left in English while
  // the title and body beside it were composed in the reader's locale.
  it('renders the timestamp through the locale, not a hand-written suffix', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    render(
      <NotificationList
        {...defaultProps}
        notifications={[makeNotification({ createdAt: twoHoursAgo })]}
      />,
    );

    // Intl's own wording for the reader's locale (English here), never `2h ago`.
    expect(screen.getByText(/2 hours ago/i)).toBeInTheDocument();
    expect(screen.queryByText(/^\d+h ago$/)).not.toBeInTheDocument();
  });

  it('renders the notification list container', () => {
    render(<NotificationList {...defaultProps} />);

    expect(screen.getByTestId('notification-list')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<NotificationList {...defaultProps} isLoading={true} />);

    expect(screen.getByText('Loading notifications...')).toBeInTheDocument();
  });

  it('shows empty state when no notifications', () => {
    render(<NotificationList {...defaultProps} />);

    expect(screen.getByTestId('no-notifications')).toHaveTextContent('No notifications');
  });

  it('renders notification items', () => {
    const notifications = [
      makeNotification({ id: 'a1', title: 'Groceries over budget', severity: 'critical' }),
      makeNotification({ id: 'a2', title: 'Dining near limit', severity: 'warning' }),
    ];

    render(<NotificationList {...defaultProps} notifications={notifications} />);

    expect(screen.getByText('Groceries over budget')).toBeInTheDocument();
    expect(screen.getByText('Dining near limit')).toBeInTheDocument();
  });

  it('shows severity badges for each notification', () => {
    const notifications = [
      makeNotification({ id: 'a1', severity: 'critical' }),
      makeNotification({ id: 'a2', severity: 'warning' }),
      makeNotification({ id: 'a3', severity: 'success' }),
      makeNotification({ id: 'a4', severity: 'info' }),
    ];

    render(<NotificationList {...defaultProps} notifications={notifications} />);

    const badges = screen.getAllByTestId('severity-badge');
    expect(badges).toHaveLength(4);
    expect(badges[0]).toHaveTextContent('Critical');
    expect(badges[1]).toHaveTextContent('Warning');
    expect(badges[2]).toHaveTextContent('Good News');
    expect(badges[3]).toHaveTextContent('Info');
  });

  it('shows unread dots for unread notifications', () => {
    const notifications = [
      makeNotification({ id: 'a1', isRead: false }),
      makeNotification({ id: 'a2', isRead: true }),
    ];

    render(<NotificationList {...defaultProps} notifications={notifications} />);

    const unreadDots = screen.getAllByTestId('unread-dot');
    expect(unreadDots).toHaveLength(1);
  });

  it('shows unread count in header', () => {
    const notifications = [
      makeNotification({ id: 'a1', isRead: false }),
      makeNotification({ id: 'a2', isRead: false }),
      makeNotification({ id: 'a3', isRead: true }),
    ];

    render(<NotificationList {...defaultProps} notifications={notifications} />);

    expect(screen.getByText('2 unread')).toBeInTheDocument();
  });

  it('shows mark all read button when there are unread notifications', () => {
    const notifications = [makeNotification({ id: 'a1', isRead: false })];

    render(<NotificationList {...defaultProps} notifications={notifications} />);

    expect(screen.getByTestId('mark-all-read')).toBeInTheDocument();
  });

  it('hides mark all read button when all notifications are read', () => {
    const notifications = [makeNotification({ id: 'a1', isRead: true })];

    render(<NotificationList {...defaultProps} notifications={notifications} />);

    expect(screen.queryByTestId('mark-all-read')).not.toBeInTheDocument();
  });

  it('calls onMarkAllRead when mark all read is clicked', () => {
    const onMarkAllRead = vi.fn();
    const notifications = [makeNotification({ id: 'a1', isRead: false })];

    render(
      <NotificationList {...defaultProps} notifications={notifications} onMarkAllRead={onMarkAllRead} />,
    );

    fireEvent.click(screen.getByTestId('mark-all-read'));

    expect(onMarkAllRead).toHaveBeenCalled();
  });

  it('calls onMarkRead and navigates when unread notification is clicked', () => {
    const onMarkRead = vi.fn();
    const onClose = vi.fn();
    const notifications = [
      makeNotification({ id: 'a1', budgetId: 'budget-123', isRead: false }),
    ];

    render(
      <NotificationList
        {...defaultProps}
        notifications={notifications}
        onMarkRead={onMarkRead}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('notification-item-a1'));

    expect(onMarkRead).toHaveBeenCalledWith('a1');
    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-123');
  });

  it('navigates without marking read when read notification is clicked', () => {
    const onMarkRead = vi.fn();
    const onClose = vi.fn();
    const notifications = [
      makeNotification({ id: 'a1', budgetId: 'budget-456', isRead: true }),
    ];

    render(
      <NotificationList
        {...defaultProps}
        notifications={notifications}
        onMarkRead={onMarkRead}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('notification-item-a1'));

    expect(onMarkRead).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-456');
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    const notifications = [makeNotification({ id: 'a1' })];

    render(<NotificationList {...defaultProps} notifications={notifications} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId('dismiss-notification-a1'));

    expect(onDismiss).toHaveBeenCalledWith('a1');
  });

  it('does not navigate when dismiss button is clicked', () => {
    const onClose = vi.fn();
    const notifications = [makeNotification({ id: 'a1' })];

    render(<NotificationList {...defaultProps} notifications={notifications} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('dismiss-notification-a1'));

    expect(onClose).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('navigates to bills page when BILL_DUE notification is clicked', () => {
    const onMarkRead = vi.fn();
    const onClose = vi.fn();
    const notifications = [
      makeNotification({
        id: 'bill-notification-1',
        type: 'BILL_DUE',
        severity: 'info',
        title: 'Netflix due tomorrow',
        message: 'USD 15.99 due on 2026-02-21',
        budgetId: '',
        isRead: false,
      }),
    ];

    render(
      <NotificationList
        {...defaultProps}
        notifications={notifications}
        onMarkRead={onMarkRead}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('notification-item-bill-notification-1'));

    expect(onMarkRead).toHaveBeenCalledWith('bill-notification-1');
    expect(onClose).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  // ---- BILL_DUE copy comes from the notification's data, in the reader's language ----
  //
  // The row is written by a cron under no request locale, so a stored sentence
  // cannot be translated after the fact (issue #1247). `title`/`message` stay on
  // the row as the fallback for a consumer with no catalog.

  const billDueAlert = (data: Record<string, unknown>): Notification =>
    makeNotification({
      id: 'notification-bill',
      type: 'BILL_DUE',
      severity: 'info',
      title: 'STORED ENGLISH TITLE',
      message: 'STORED ENGLISH MESSAGE',
      data,
    });

  it('composes a bill-due notification from its structured data', () => {
    render(
      <NotificationList
        {...defaultProps}
        notifications={[
          billDueAlert({
            billId: 'st-1',
            payeeName: 'Power Co',
            amount: 312.65,
            amountComplete: true,
            dueDate: daysFromToday(3),
            currencyCode: 'USD',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Power Co due in 3 days')).toBeInTheDocument();
    // The date is rendered in the reader's preference, not the stored ISO.
    expect(
      screen.getByText(new RegExp(`312\\.65 due on ${asUserDate(daysFromToday(3))}`)),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(daysFromToday(3))),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('STORED ENGLISH TITLE')).not.toBeInTheDocument();
    expect(screen.queryByText('STORED ENGLISH MESSAGE')).not.toBeInTheDocument();
  });

  /**
   * The due date follows the reader's `dateFormat` preference, like every date
   * the register and reports draw -- it was interpolated as the stored
   * `YYYY-MM-DD`, so a reader on `DD.MM.YYYY` saw `2026-09-15` where the rest
   * of the app shows `15.09.2026`. A different pattern than the suite default
   * (`MM/DD/YYYY` here) proves the preference is what drives the output.
   */
  it('renders the due date in the reader date-format preference, not raw ISO', () => {
    usePreferencesStore.setState({
      preferences: { dateFormat: 'MM/DD/YYYY' } as never,
    });
    render(
      <NotificationList
        {...defaultProps}
        notifications={[
          billDueAlert({
            payeeName: 'Power Co',
            amount: 312.65,
            amountComplete: true,
            dueDate: daysFromToday(3),
            currencyCode: 'USD',
          }),
        ]}
      />,
    );

    const [y, m, d] = daysFromToday(3).split('-');
    expect(
      screen.getByText(new RegExp(`due on ${m}/${d}/${y}`)),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(daysFromToday(3))),
    ).not.toBeInTheDocument();
  });

  it('says the amount is unavailable rather than leaving a blank or a stale figure', () => {
    render(
      <NotificationList
        {...defaultProps}
        notifications={[
          billDueAlert({
            billId: 'st-1',
            payeeName: 'Monthly ETF buy',
            amount: null,
            amountComplete: false,
            dueDate: daysFromToday(0),
            currencyCode: 'CAD',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Monthly ETF buy due today')).toBeInTheDocument();
    expect(
      screen.getByText(
        `Amount unavailable (no current exchange rate), due on ${asUserDate(daysFromToday(0))}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('STORED ENGLISH MESSAGE')).not.toBeInTheDocument();
  });

  it('says tomorrow rather than "in 1 days"', () => {
    render(
      <NotificationList
        {...defaultProps}
        notifications={[
          billDueAlert({
            payeeName: 'Netflix',
            amount: 15.99,
            amountComplete: true,
            dueDate: daysFromToday(1),
            currencyCode: 'USD',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Netflix due tomorrow')).toBeInTheDocument();
  });

  /**
   * The row lives until it is dismissed, so the copy is counted from `dueDate`
   * against the reader's clock -- a stored "in 3 days" would still say three days
   * a week later.
   */
  it('says overdue once the due date has passed', () => {
    render(
      <NotificationList
        {...defaultProps}
        notifications={[
          billDueAlert({
            payeeName: 'Power Co',
            amount: 312.65,
            amountComplete: true,
            dueDate: daysFromToday(-2),
            currencyCode: 'USD',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Power Co overdue')).toBeInTheDocument();
  });

  it('falls back to the stored copy for a row written before the data existed', () => {
    // Absent is "no information", not a licence to render nothing: a row from an
    // older release carries only its English sentence.
    render(
      <NotificationList
        {...defaultProps}
        notifications={[billDueAlert({ billId: 'st-1', payeeName: 'Power Co' })]}
      />,
    );

    expect(screen.getByText('STORED ENGLISH TITLE')).toBeInTheDocument();
    expect(screen.getByText('STORED ENGLISH MESSAGE')).toBeInTheDocument();
  });

  it('displays notification message text', () => {
    const notifications = [
      makeNotification({
        id: 'a1',
        message: 'You have used 85% of your Groceries budget ($425 of $500).',
      }),
    ];

    render(<NotificationList {...defaultProps} notifications={notifications} />);

    expect(
      screen.getByText('You have used 85% of your Groceries budget ($425 of $500).'),
    ).toBeInTheDocument();
  });

  it('shows inline undo when notification is in dismissingIds', () => {
    const notifications = [
      makeNotification({ id: 'a1' }),
      makeNotification({ id: 'a2', title: 'Second notification' }),
    ];

    render(
      <NotificationList
        {...defaultProps}
        notifications={notifications}
        dismissingIds={new Set(['a1'])}
      />,
    );

    // Dismissed notification shows undo, not normal content
    expect(screen.queryByTestId('notification-item-a1')).not.toBeInTheDocument();
    expect(screen.getByTestId('undo-dismiss-a1')).toBeInTheDocument();
    // Other notification is still normal
    expect(screen.getByTestId('notification-item-a2')).toBeInTheDocument();
  });

  it('calls onUndoDismiss when undo is clicked', () => {
    const onUndoDismiss = vi.fn();
    const notifications = [makeNotification({ id: 'a1' })];

    render(
      <NotificationList
        {...defaultProps}
        notifications={notifications}
        dismissingIds={new Set(['a1'])}
        onUndoDismiss={onUndoDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId('undo-dismiss-a1'));

    expect(onUndoDismiss).toHaveBeenCalledWith('a1');
  });

  it('excludes dismissing notifications from unread count', () => {
    const notifications = [
      makeNotification({ id: 'a1', isRead: false }),
      makeNotification({ id: 'a2', isRead: false }),
    ];

    render(
      <NotificationList
        {...defaultProps}
        notifications={notifications}
        dismissingIds={new Set(['a1'])}
      />,
    );

    expect(screen.getByText('1 unread')).toBeInTheDocument();
  });

  // ---- System notifications (data.system === true) ----
  //
  // Same contract as BILL_DUE: the row stores English fallbacks written by a
  // cron with no request locale; the UI composes localized copy from `data`.

  const systemNotification = (overrides: Partial<Notification>): Notification =>
    makeNotification({
      id: 'notification-sys',
      budgetId: null,
      budgetCategoryId: null,
      severity: 'warning',
      title: 'STORED ENGLISH TITLE',
      message: 'STORED ENGLISH MESSAGE',
      ...overrides,
    });

  describe('system notifications', () => {
    it('routes backup and mail issues to settings', () => {
      for (const type of [
        'BACKUP_FAILED',
        'BACKUP_PARTIAL',
        'ENCRYPTION_KEY_MISSING',
        'SMTP_FAILURE',
      ] as const) {
        mockPush.mockClear();
        const { unmount } = render(
          <NotificationList
            {...defaultProps}
            notifications={[systemNotification({ id: 'sys-1', type, data: {} })]}
          />,
        );
        fireEvent.click(screen.getByTestId('notification-item-sys-1'));
        expect(mockPush).toHaveBeenCalledWith('/settings');
        unmount();
      }
    });

    it('routes a scheduled-post failure to bills', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({ id: 'sys-1', type: 'SCHEDULED_POST_FAILED', data: {} }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId('notification-item-sys-1'));
      expect(mockPush).toHaveBeenCalledWith('/bills');
    });

    it('marks a provider notification read and expands it in place -- no page says more than the notification', () => {
      const onMarkRead = vi.fn();
      const onClose = vi.fn();
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({ id: 'sys-1', type: 'PROVIDER_OUTAGE', data: {} }),
          ]}
          onMarkRead={onMarkRead}
          onClose={onClose}
        />,
      );
      fireEvent.click(screen.getByTestId('notification-item-sys-1'));
      expect(onMarkRead).toHaveBeenCalledWith('sys-1');
      expect(onClose).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.getByTestId('notification-item-sys-1')).toHaveAttribute('aria-expanded', 'true');
    });

    it('renders a weak JWT_SECRET alert in the reader language and opens no page', () => {
      const onClose = vi.fn();
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              id: 'sys-1',
              type: 'JWT_SECRET_WEAK',
              data: { system: true, reason: 'placeholder' },
            }),
          ]}
          onClose={onClose}
        />,
      );
      expect(screen.getByText('JWT_SECRET is weak')).toBeInTheDocument();
      expect(screen.getByText(/users sign in with a backup code/)).toBeInTheDocument();
      expect(screen.queryByText('STORED ENGLISH TITLE')).not.toBeInTheDocument();
      // The message is longer than the two-line preview: it starts clamped, and
      // clicking the row (which has no page to open) shows it in full instead
      // of closing the panel.
      const message = screen.getByTestId('notification-message-sys-1');
      expect(message).toHaveClass('line-clamp-2');
      fireEvent.click(screen.getByTestId('notification-item-sys-1'));
      expect(message).not.toHaveClass('line-clamp-2');
      expect(screen.getByTestId('notification-item-sys-1')).toHaveAttribute('aria-expanded', 'true');
      expect(onClose).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
      // A second click collapses it again.
      fireEvent.click(screen.getByTestId('notification-item-sys-1'));
      expect(message).toHaveClass('line-clamp-2');
    });

    it('keeps a routed notification a plain link: no expansion, closes and navigates', () => {
      const onClose = vi.fn();
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({ id: 'sys-2', type: 'BACKUP_FAILED', data: {} }),
          ]}
          onClose={onClose}
        />,
      );
      expect(screen.getByTestId('notification-item-sys-2')).not.toHaveAttribute('aria-expanded');
      fireEvent.click(screen.getByTestId('notification-item-sys-2'));
      expect(onClose).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalled();
    });

    // The producer knows which page its notification is about; the client only
    // knows the type. So the server's target wins over the type table.
    it('follows the server target in preference to the type it would derive', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              id: 'sys-1',
              type: 'SCHEDULED_POST_FAILED',
              data: {},
              target: '/scheduled-transactions/st-7',
            }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId('notification-item-sys-1'));
      expect(mockPush).toHaveBeenCalledWith('/scheduled-transactions/st-7');
    });

    // A rolling deploy has both shapes in one list, so the type table is the
    // fallback rather than dead code.
    it('falls back to the type table for a row written before targets existed', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({ id: 'sys-1', type: 'SCHEDULED_POST_FAILED', data: {} }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId('notification-item-sys-1'));
      expect(mockPush).toHaveBeenCalledWith('/bills');
    });

    // `router.push` with an absolute URL is an open redirect, and a target the
    // client cannot vouch for is dropped rather than followed -- the fallback
    // then answers, so the reader still lands somewhere useful.
    it('ignores a target that is not a same-origin path', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              id: 'sys-1',
              type: 'SCHEDULED_POST_FAILED',
              data: {},
              target: '//evil.example/steal',
            }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId('notification-item-sys-1'));
      expect(mockPush).toHaveBeenCalledWith('/bills');
      expect(mockPush).not.toHaveBeenCalledWith('//evil.example/steal');
    });

    it('never pushes /budgets/null for a budget-typed notification whose budgetId is null', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({ id: 'sys-1', type: 'THRESHOLD_WARNING', data: {} }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId('notification-item-sys-1'));
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('composes a backup failure from its data, naming the affected user and the error', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              type: 'BACKUP_FAILED',
              severity: 'critical',
              data: {
                system: true,
                affectedUserId: 'u-1',
                affectedUserEmail: 'ken@example.com',
                error: 'ENOSPC: no space left on device',
              },
            }),
          ]}
        />,
      );
      expect(screen.getByText('Automatic backup failed')).toBeInTheDocument();
      expect(
        screen.getByText(
          'The automatic backup for ken@example.com failed: ENOSPC: no space left on device',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText('STORED ENGLISH TITLE')).not.toBeInTheDocument();
    });

    it('falls back to the user id when the email lookup failed', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              type: 'BACKUP_FAILED',
              data: {
                system: true,
                affectedUserId: 'u-1',
                affectedUserEmail: null,
                error: 'boom',
              },
            }),
          ]}
        />,
      );
      expect(
        screen.getByText('The automatic backup for u-1 failed: boom'),
      ).toBeInTheDocument();
    });

    it('switches the partial-backup message on its reason, carrying its cause', () => {
      const base = {
        system: true,
        affectedUserId: 'u-1',
        affectedUserEmail: 'ken@example.com',
      };
      for (const [data, fragment] of [
        [
          {
            reason: 'attachments',
            missingAttachments: 2,
            inconsistentAttachments: 0,
            expectedAttachments: 7,
          },
          /2 of 7 attachments could not be included and 0 did not match/,
        ],
        [
          { reason: 'promotion', error: 'weekly: EACCES: permission denied' },
          /weekly or monthly copy could not be written: weekly: EACCES/,
        ],
        [
          { reason: 'retention', error: 'daily-2026-04-01: EACCES' },
          /old backup files could not be cleaned up: daily-2026-04-01/,
        ],
      ] as const) {
        const { unmount } = render(
          <NotificationList
            {...defaultProps}
            notifications={[
              systemNotification({
                type: 'BACKUP_PARTIAL',
                data: { ...base, ...data },
              }),
            ]}
          />,
        );
        expect(screen.getByText(fragment)).toBeInTheDocument();
        unmount();
      }
    });

    it('states an inconsistency-only partial truthfully, not as "0 attachments"', () => {
      // Reading only `missingAttachments` said "0 attachments could not be
      // included" for a run whose attachments were all present and did not
      // match their metadata -- a stored English message that was correct,
      // replaced by a localized one that was not.
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              type: 'BACKUP_PARTIAL',
              data: {
                system: true,
                affectedUserEmail: 'ken@example.com',
                reason: 'attachments',
                missingAttachments: 0,
                inconsistentAttachments: 3,
                expectedAttachments: 7,
              },
            }),
          ]}
        />,
      );
      expect(
        screen.getByText(/0 of 7 attachments could not be included and 3 did not match/),
      ).toBeInTheDocument();
    });

    it('falls back to the stored English when a partial payload lacks its counts', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              type: 'BACKUP_PARTIAL',
              data: {
                system: true,
                affectedUserEmail: 'ken@example.com',
                reason: 'promotion',
              },
            }),
          ]}
        />,
      );
      expect(screen.getByText('STORED ENGLISH MESSAGE')).toBeInTheDocument();
    });

    it('composes the provider pair from the stored label', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              id: 'sys-out',
              type: 'PROVIDER_OUTAGE',
              data: { system: true, providerLabel: 'Yahoo Finance' },
            }),
            systemNotification({
              id: 'sys-rec',
              type: 'PROVIDER_RECOVERED',
              severity: 'success',
              data: { system: true, providerLabel: 'Yahoo Finance' },
            }),
          ]}
        />,
      );
      expect(
        screen.getByText('Yahoo Finance is not responding'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Yahoo Finance is answering again'),
      ).toBeInTheDocument();
    });

    it('composes a scheduled-post failure with the schedule name, date and error', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[
            systemNotification({
              type: 'SCHEDULED_POST_FAILED',
              data: {
                system: true,
                scheduledId: 'st-1',
                scheduledName: 'Rent',
                dueDate: '2026-09-01',
                error: 'account is closed',
              },
            }),
          ]}
        />,
      );
      expect(screen.getByText('Rent could not be posted')).toBeInTheDocument();
      // The due date shows in the reader's preference (01.09.2026), not 2026-09-01.
      expect(
        screen.getByText(
          'Your scheduled transaction due 01.09.2026 did not post automatically: account is closed. You can post it manually from Bills.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/2026-09-01/)).not.toBeInTheDocument();
    });

    it('falls back to the stored English for a row without the structured payload', () => {
      render(
        <NotificationList
          {...defaultProps}
          notifications={[systemNotification({ type: 'BACKUP_FAILED', data: {} })]}
        />,
      );
      expect(screen.getByText('STORED ENGLISH TITLE')).toBeInTheDocument();
      expect(screen.getByText('STORED ENGLISH MESSAGE')).toBeInTheDocument();
    });
  });

  describe('bank sync notifications', () => {
    // The producer (`docs/specs/bank-sync-notifications.md`) writes facts, never
    // "in 3 days": the stored mark and date are rendered, so a row read weeks
    // after it was written says what it said on the day.
    const bankSyncRow = (
      type: Notification['type'],
      data: Record<string, unknown>,
      over: Partial<Notification> = {},
    ): Notification =>
      makeNotification({
        id: 'bank-sync-1',
        budgetId: null,
        budgetCategoryId: null,
        type,
        severity: 'warning',
        title: 'STORED ENGLISH TITLE',
        message: 'STORED ENGLISH MESSAGE',
        target: '/settings/bank-sync',
        data,
        ...over,
      });

    const renderRow = (row: Notification) =>
      render(<NotificationList {...defaultProps} notifications={[row]} />);

    it.each([
      [30, 'Alpha Bank: bank access ends within 30 days'],
      [7, 'Alpha Bank: bank access ends within 7 days'],
      [2, 'Alpha Bank: bank access ends within 2 days'],
      [1, 'Alpha Bank: bank access ends within 1 day'],
      [0, 'Alpha Bank: bank access ends today'],
    ])('words the %s-day consent reminder from the stored mark', (threshold, title) => {
      renderRow(
        bankSyncRow('BANK_SYNC_CONSENT_EXPIRING', {
          connectionId: 'c1',
          institutionName: 'Alpha Bank',
          validUntil: '2027-03-30',
          threshold,
        }),
      );

      expect(screen.getByText(title)).toBeInTheDocument();
      // The end is a stored date in the reader's date format, not the raw ISO.
      expect(
        screen.getByText(/ends on 30\.03\.2027\. Renew the connection/),
      ).toBeInTheDocument();
      expect(screen.queryByText('STORED ENGLISH TITLE')).not.toBeInTheDocument();
    });

    it('says the same on any day it is read: nothing is counted from the clock', () => {
      renderRow(
        bankSyncRow(
          'BANK_SYNC_CONSENT_EXPIRING',
          {
            institutionName: 'Alpha Bank',
            validUntil: '2020-01-31',
            threshold: 14,
          },
          { createdAt: '2019-12-31T06:23:00.000Z' },
        ),
      );
      // A row whose end is long past still reads as it was written.
      expect(
        screen.getByText('Alpha Bank: bank access ends within 14 days'),
      ).toBeInTheDocument();
    });

    it('opens the bank sync settings when the row is clicked', () => {
      renderRow(
        bankSyncRow('BANK_SYNC_CONSENT_EXPIRED', {
          institutionName: 'Alpha Bank',
          validUntil: '2027-03-30',
        }),
      );
      fireEvent.click(screen.getByTestId('notification-item-bank-sync-1'));
      expect(mockPush).toHaveBeenCalledWith('/settings/bank-sync');
    });

    it('says the consent has ended', () => {
      renderRow(
        bankSyncRow('BANK_SYNC_CONSENT_EXPIRED', {
          institutionName: 'Alpha Bank',
          validUntil: null,
        }),
      );
      expect(screen.getByText('Alpha Bank: bank access has ended')).toBeInTheDocument();
      expect(screen.getByText(/has ended\. Renew the connection in Monize to resume syncing/)).toBeInTheDocument();
    });

    it('lists the failed accounts by label, in the reader\'s language', () => {
      renderRow(
        bankSyncRow('BANK_SYNC_FAILED', {
          institutionName: 'Alpha Bank',
          failures: [
            { bankAccountId: 'b1', label: 'Main account', code: 'rate_limited' },
            { bankAccountId: 'b2', label: 'Savings', code: 'unavailable' },
            { bankAccountId: 'b3', label: null, code: 'unavailable' },
          ],
        }),
      );
      expect(screen.getByText('Alpha Bank: sync failed')).toBeInTheDocument();
      expect(
        screen.getByText(/failed for: Main account, Savings, and an account\./),
      ).toBeInTheDocument();
    });

    it('says one thing when every account failed on the credentials', () => {
      renderRow(
        bankSyncRow('BANK_SYNC_FAILED', {
          institutionName: 'Alpha Bank',
          failures: [{ bankAccountId: 'b1', label: 'Main', code: 'credentials' }],
        }),
      );
      expect(screen.getByText(/credentials are missing or were rejected/)).toBeInTheDocument();
      expect(screen.queryByText(/Main/)).not.toBeInTheDocument();
    });

    it('formats the imported count in the reader\'s number format', () => {
      renderRow(
        bankSyncRow(
          'BANK_SYNC_IMPORTED',
          { institutionName: 'Alpha Bank', imported: 1234, skipped: 0, accounts: 2 },
          { severity: 'success' },
        ),
      );
      expect(screen.getByText('Alpha Bank: new transactions imported')).toBeInTheDocument();
      expect(screen.getByText(/imported from Alpha Bank by the daily sync: 1,234\./)).toBeInTheDocument();
    });

    it('reports a sync that found nothing as such', () => {
      renderRow(
        bankSyncRow(
          'BANK_SYNC_IMPORTED',
          { institutionName: 'Alpha Bank', imported: 0, skipped: 3, accounts: 1 },
          { severity: 'success' },
        ),
      );
      expect(screen.getByText('Alpha Bank: no new transactions')).toBeInTheDocument();
      expect(screen.getByText(/found no new transactions/)).toBeInTheDocument();
    });

    it.each([
      ['an unknown mark', 'BANK_SYNC_CONSENT_EXPIRING', { institutionName: 'A', validUntil: '2027-03-30', threshold: 5 }],
      ['no date', 'BANK_SYNC_CONSENT_EXPIRING', { institutionName: 'A', threshold: 7 }],
      ['no institution', 'BANK_SYNC_CONSENT_EXPIRED', {}],
      ['an empty failure list', 'BANK_SYNC_FAILED', { institutionName: 'A', failures: [] }],
      ['a malformed failure', 'BANK_SYNC_FAILED', { institutionName: 'A', failures: [{ label: 'x' }] }],
      ['a fractional count', 'BANK_SYNC_IMPORTED', { institutionName: 'A', imported: 1.5 }],
      ['a negative count', 'BANK_SYNC_IMPORTED', { institutionName: 'A', imported: -1 }],
    ] as const)('falls back to the stored English for %s', (_label, type, data) => {
      renderRow(bankSyncRow(type, { ...data }));
      expect(screen.getByText('STORED ENGLISH TITLE')).toBeInTheDocument();
      expect(screen.getByText('STORED ENGLISH MESSAGE')).toBeInTheDocument();
    });
  });

  describe('filters', () => {
    it('renders one chip per severity and per category', () => {
      render(<NotificationList {...defaultProps} />);

      for (const severity of ['critical', 'warning', 'info', 'success']) {
        expect(
          screen.getByTestId(`notification-filter-severity-${severity}`),
        ).toHaveAttribute('aria-pressed', 'false');
      }
      for (const category of ['financial', 'system']) {
        expect(
          screen.getByTestId(`notification-filter-category-${category}`),
        ).toHaveAttribute('aria-pressed', 'false');
      }
    });

    it('renders the category chips on their own row below the severity chips', () => {
      render(<NotificationList {...defaultProps} />);

      const severityRow = screen.getByTestId('notification-filter-severity-critical')
        .parentElement as HTMLElement;
      const categoryRow = screen.getByTestId('notification-filter-category-system')
        .parentElement as HTMLElement;
      expect(severityRow).not.toBe(categoryRow);
      // Same stacked container, severity row first.
      expect(categoryRow.parentElement).toBe(severityRow.parentElement);
      expect(severityRow.nextElementSibling).toBe(categoryRow);
    });

    it('activates a severity filter on click', () => {
      render(<NotificationList {...defaultProps} />);

      fireEvent.click(screen.getByTestId('notification-filter-severity-critical'));

      expect(defaultProps.onFiltersChange).toHaveBeenCalledWith({
        severity: 'critical',
        category: null,
      });
    });

    it('clears an active severity filter on a second click', () => {
      render(
        <NotificationList
          {...defaultProps}
          filters={{ severity: 'critical', category: null }}
        />,
      );

      const chip = screen.getByTestId('notification-filter-severity-critical');
      expect(chip).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(chip);

      expect(defaultProps.onFiltersChange).toHaveBeenCalledWith({
        severity: null,
        category: null,
      });
    });

    it('activates a category filter without touching the severity filter', () => {
      render(
        <NotificationList
          {...defaultProps}
          filters={{ severity: 'warning', category: null }}
        />,
      );

      fireEvent.click(screen.getByTestId('notification-filter-category-system'));

      expect(defaultProps.onFiltersChange).toHaveBeenCalledWith({
        severity: 'warning',
        category: 'system',
      });
    });

    it('clears an active category filter on a second click', () => {
      render(
        <NotificationList
          {...defaultProps}
          filters={{ severity: null, category: 'financial' }}
        />,
      );

      fireEvent.click(screen.getByTestId('notification-filter-category-financial'));

      expect(defaultProps.onFiltersChange).toHaveBeenCalledWith({
        severity: null,
        category: null,
      });
    });

    it('tells an empty filtered view apart from having no notifications at all', () => {
      render(
        <NotificationList
          {...defaultProps}
          filters={{ severity: 'critical', category: null }}
        />,
      );

      expect(screen.getByTestId('no-notifications')).toHaveTextContent(
        'No notifications match the current filter',
      );
    });
  });

  describe('delete all', () => {
    it('offers delete-all only when notifications are shown', () => {
      const { rerender } = render(<NotificationList {...defaultProps} />);
      expect(screen.queryByTestId('delete-all-notifications')).not.toBeInTheDocument();

      rerender(
        <NotificationList {...defaultProps} notifications={[makeNotification()]} />,
      );
      expect(screen.getByTestId('delete-all-notifications')).toBeInTheDocument();
    });

    it('asks the owner to delete on click', () => {
      render(<NotificationList {...defaultProps} notifications={[makeNotification()]} />);

      fireEvent.click(screen.getByTestId('delete-all-notifications'));

      expect(defaultProps.onDeleteAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('mobile layout', () => {
    it('covers the whole screen below the sm breakpoint and stays a dropdown above it', () => {
      render(<NotificationList {...defaultProps} />);

      const container = screen.getByTestId('notification-list');
      // Full width plus an explicit viewport height is the full-screen mobile
      // treatment; the sm:-scoped classes restore the desktop dropdown card.
      expect(container.className).toContain('fixed inset-x-0 top-0');
      expect(container.className).toContain('h-dvh');
      expect(container.className).toContain('sm:h-auto');
      expect(container.className).toContain('sm:absolute');
      expect(container.className).toContain('sm:inset-auto');
      expect(container.className).toContain('sm:max-h-[28rem]');
      expect(container.className).toContain('sm:rounded-lg');
      expect(container.className).toContain('sm:w-[30rem]');
      // Never anchor this panel's height with bottom-0/inset-0: it mounts
      // inside the sliding AppHeader, whose ever-present transform makes the
      // header the containing block for position:fixed -- a bottom anchor
      // caps the panel at the header's own ~56px box, so it collapsed
      // whenever there were no notification rows overflowing it.
      expect(container.className).not.toMatch(/(?:^|\s)inset-0(?:\s|$)/);
      expect(container.className).not.toMatch(/(?:^|\s)bottom-0(?:\s|$)/);
    });

    it('centers the empty state in the leftover height instead of pinning it to the top', () => {
      render(<NotificationList {...defaultProps} />);

      // The full-screen mobile panel leaves most of the screen below the
      // header; the empty state claims that space and centers in it. The
      // desktop dropdown is content-sized, so the same classes are a no-op.
      const empty = screen.getByTestId('no-notifications');
      expect(empty.className).toContain('flex-1');
      expect(empty.className).toContain('justify-center');
      const body = empty.parentElement as HTMLElement;
      expect(body.className).toContain('flex-1');
      expect(body.className).toContain('flex-col');
    });

    it('renders a mobile-only close button that closes the panel', () => {
      render(<NotificationList {...defaultProps} />);

      const close = screen.getByTestId('close-notifications');
      expect(close.className).toContain('sm:hidden');
      fireEvent.click(close);

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });
  });
});
