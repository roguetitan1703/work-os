'use client';

import NextLink from 'next/link';
import { useState, type ComponentProps } from 'react';

// The app's Link (docs/cpu.md "Multi-user"). Next prefetches every link that scrolls into view: a route-tree request
// and a metadata request each, about 50 server renders for one Today or Tasks page, and all of them again after every
// write (a revalidating action drops the router's prefetch cache). Pages here are dynamic, so those prefetches carry no
// page data. This Link prefetches only while the pointer or focus is on it (hover, touch, keyboard): the pattern in
// Next's prefetching guide, plus disarming on leave so that a link hovered once is not prefetched again after every
// write. Today, Tasks and Projects are still warmed by components/preloader.tsx.
// An explicit prefetch (true or false) is passed through unchanged.
type Props = ComponentProps<typeof NextLink>;

export default function Link({ prefetch, onMouseEnter, onMouseLeave, onTouchStart, onFocus, onBlur, ...rest }: Props) {
  const [armed, setArmed] = useState(false);
  if (prefetch === true || prefetch === false) return <NextLink prefetch={prefetch} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onTouchStart={onTouchStart} onFocus={onFocus} onBlur={onBlur} {...rest} />;
  return (
    <NextLink
      {...rest}
      prefetch={armed ? null : false}
      onMouseEnter={e => {
        setArmed(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={e => {
        setArmed(false);
        onMouseLeave?.(e);
      }}
      onTouchStart={e => {
        setArmed(true);
        onTouchStart?.(e);
      }}
      onFocus={e => {
        setArmed(true);
        onFocus?.(e);
      }}
      onBlur={e => {
        setArmed(false);
        onBlur?.(e);
      }}
    />
  );
}
