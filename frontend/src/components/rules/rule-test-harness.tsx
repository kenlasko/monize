import { useState } from 'react';
import { RuleConditionGroup, type RuleTreeEnv } from '@/components/rules/RuleConditionGroup';
import { createTreeHandlers } from '@/components/rules/rule-tree-handlers';
import type { RuleOptions } from '@/components/rules/use-rule-options';
import { treeCapacity, type EditorGroup } from '@/lib/rule-tree';
import { ACCOUNT_ID, COFFEE_ID, FOOD_ID, PAYEE_ID, TAG_ID, TAG_WORK_ID } from './rules-test-fixtures';

/** The lists the pickers offer, already built. */
export const testOptions: RuleOptions = {
  accounts: [{ value: ACCOUNT_ID, label: 'Chequing (CAD)' }],
  transferAccounts: [{ value: ACCOUNT_ID, label: 'Chequing (CAD)' }],
  payees: [{ value: PAYEE_ID, label: 'Corner Cafe' }],
  categories: [
    { value: FOOD_ID, label: 'Food' },
    { value: COFFEE_ID, label: 'Food: Coffee' },
  ],
  tags: [
    { value: TAG_ID, label: 'Coffee run' },
    { value: TAG_WORK_ID, label: 'Work' },
  ],
  currencyCodes: ['CAD', 'USD'],
};

/**
 * A condition tree held in state and wired to the real handlers, so a test
 * drives the group the way the editor does. `onRoot` sees every new root.
 */
export function GroupHarness({
  initial,
  errors = {},
  onRoot,
}: {
  initial: EditorGroup;
  errors?: RuleTreeEnv['errors'];
  onRoot?: (root: EditorGroup) => void;
}) {
  const [root, setRoot] = useState(initial);
  const edit = (fn: (current: EditorGroup) => EditorGroup) => {
    const next = fn(root);
    setRoot(next);
    onRoot?.(next);
  };
  const env: RuleTreeEnv = {
    root,
    options: testOptions,
    errors,
    capacity: treeCapacity(root),
    handlers: createTreeHandlers(edit),
  };
  return <RuleConditionGroup group={root} path={[]} env={env} />;
}
