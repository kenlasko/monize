---
title: "Dashboard widget settings are merged on the server one widget at a time, not one setting at a time"
author: Ken
date: 2026-11-11
branch: feat/dashboard-edit-mode
cost: { minutes: 36, tokens: 175541 }
id: l-9a354469
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/dashboard/dashboard-layout.ts
  - frontend/src/hooks/useDashboardLayoutDraft.ts
  - frontend/src/i18n/messages/de/dashboard.json
  - frontend/src/i18n/messages/es/dashboard.json
  - frontend/src/i18n/messages/fr/dashboard.json
  - frontend/src/i18n/messages/hi/dashboard.json
  - frontend/src/i18n/messages/id/dashboard.json
  - frontend/src/i18n/messages/it/dashboard.json
  - frontend/src/i18n/messages/ja/dashboard.json
  - frontend/src/i18n/messages/ko/dashboard.json
---

## Decided
A save of the per-widget dashboard settings map is merged into the stored map by widget id: each widget's settings that are sent replace that widget's stored settings whole, a widget sent as null is removed, and a widget not sent is kept. Every screen that writes the map sends only the widgets it owns: a widget's own settings save sends its own, the dashboard's edit mode sends only the widgets whose size changed, the hero dialog sends the hero's. Before this, the server replaced the whole map, so a save built from an older copy (another device, or a widget save still in flight when edit mode's Done landed) silently dropped every widget size or setting stored since.

## Tried and ruled out
Merging one level deeper, setting by setting inside a widget: a widget clears a setting by leaving its key out (removing a custom display name sends the widget's settings without `displayName`), so a key-level merge would make a cleared name come back. It would need null-as-delete markers in every widget's save.

## Watch out
Within one widget the race remains: a widget's own save and edit mode's Done both touching the same widget can still overwrite each other's keys for that widget. Cards are inert in edit mode, so this needs a save already in flight when edit mode is entered.

In the code: backend/src/users/widget-config-merge.ts (mergeWidgetConfig, called from UsersService.updatePreferences under the row lock viewDefaults and hiddenTableColumns already take); frontend serializeDashboardLayout returns a WidgetConfigPatch; useWidgetConfig and DashboardHeroSettingsModal send one slice.
