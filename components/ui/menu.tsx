'use client';

import * as React from 'react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { CheckIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ui } from '@/lib/ui-tokens';

// The app's menu (Base UI Menu), styled with the shared tokens (lib/ui-tokens.ts): rounded-xl panel, 36px rows,
// dividers between groups, muted right-aligned shortcuts. Keyboard: arrows move, Enter picks, Escape closes.

const Menu = MenuPrimitive.Root;
const MenuTrigger = MenuPrimitive.Trigger;
const MenuSubmenu = MenuPrimitive.SubmenuRoot;
const MenuRadioGroup = MenuPrimitive.RadioGroup;

function MenuContent({
  side = 'top',
  align = 'start',
  sideOffset = 6,
  className,
  children,
  testId,
}: {
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  className?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} className="z-[200] outline-none">
        <MenuPrimitive.Popup data-slot="menu-content" data-menu={testId} className={cn(ui.panel, 'min-w-60 max-w-[min(20rem,calc(100vw-1rem))]', className)}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

const item = cn(ui.row, 'cursor-default select-none text-foreground data-highlighted:bg-muted data-highlighted:text-foreground');

function MenuItem({ icon, hint, children, className, ...props }: Omit<MenuPrimitive.Item.Props, 'className'> & { icon?: React.ReactNode; hint?: string; className?: string }) {
  return (
    <MenuPrimitive.Item {...props} className={cn(item, className)}>
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {hint && <span className={ui.kbd}>{hint}</span>}
    </MenuPrimitive.Item>
  );
}

function MenuSubmenuTrigger({ icon, children, ...props }: Omit<MenuPrimitive.SubmenuTrigger.Props, 'className'> & { icon?: React.ReactNode }) {
  return (
    <MenuPrimitive.SubmenuTrigger {...props} className={cn(item, 'data-popup-open:bg-muted')}>
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuRadioItem({ icon, children, ...props }: Omit<MenuPrimitive.RadioItem.Props, 'className'> & { icon?: React.ReactNode }) {
  return (
    <MenuPrimitive.RadioItem closeOnClick {...props} className={item}>
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      <MenuPrimitive.RadioItemIndicator className="flex size-4 items-center justify-center">
        <CheckIcon className="size-4" aria-hidden />
      </MenuPrimitive.RadioItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

/** A muted line at the top of a menu (the email) or above a group. */
function MenuLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('px-2.5 py-1.5 text-[13px] text-muted-foreground', className)}>{children}</div>;
}

function MenuSeparator() {
  return <MenuPrimitive.Separator className={ui.divider} />;
}

export { Menu, MenuTrigger, MenuContent, MenuItem, MenuSubmenu, MenuSubmenuTrigger, MenuRadioGroup, MenuRadioItem, MenuLabel, MenuSeparator };
