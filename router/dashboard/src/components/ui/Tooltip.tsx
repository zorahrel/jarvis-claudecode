import { Fragment, cloneElement, isValidElement, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Placement = 'right' | 'left' | 'top' | 'bottom'

interface TooltipProps {
  content: ReactNode
  placement?: Placement
  /** Delay in ms before the tooltip appears. Native browser delay is ~1500ms — we default to 120ms. */
  delay?: number
  /** Fallback when `content` is empty — render the child without wrapping. */
  disabled?: boolean
  children: ReactElement
}

function renderContent(content: ReactNode): { node: ReactNode; multiline: boolean } {
  if (typeof content === 'string' && content.includes('\n')) {
    const lines = content.split('\n')
    return {
      multiline: true,
      node: lines.map((line, i) => (
        <Fragment key={i}>
          {line}
          {i < lines.length - 1 && <br />}
        </Fragment>
      )),
    }
  }
  return { node: content, multiline: false }
}

interface PopoverState {
  x: number
  y: number
  placement: Placement
}

const OFFSET = 8

function computePosition(rect: DOMRect, placement: Placement): { x: number; y: number } {
  switch (placement) {
    case 'right':
      return { x: rect.right + OFFSET, y: rect.top + rect.height / 2 }
    case 'left':
      return { x: rect.left - OFFSET, y: rect.top + rect.height / 2 }
    case 'top':
      return { x: rect.left + rect.width / 2, y: rect.top - OFFSET }
    case 'bottom':
      return { x: rect.left + rect.width / 2, y: rect.bottom + OFFSET }
  }
}

function transformFor(placement: Placement): string {
  switch (placement) {
    case 'right': return 'translate(0, -50%)'
    case 'left':  return 'translate(-100%, -50%)'
    case 'top':   return 'translate(-50%, -100%)'
    case 'bottom':return 'translate(-50%, 0)'
  }
}

/**
 * Fast, portaled tooltip. Drop-in wrapper around a single interactive child.
 * Shows after `delay` ms (120ms by default) and disappears instantly on leave.
 */
export function Tooltip({ content, placement = 'right', delay = 120, disabled, children }: TooltipProps) {
  const [state, setState] = useState<PopoverState | null>(null)
  const timerRef = useRef<number | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const show = useCallback(() => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const { x, y } = computePosition(rect, placement)
      setState({ x, y, placement })
    }, delay)
  }, [placement, delay])

  const hide = useCallback(() => {
    clearTimer()
    setState(null)
  }, [])

  useEffect(() => () => clearTimer(), [])

  if (disabled || !content || !isValidElement(children)) {
    return children
  }

  const childProps = (children.props ?? {}) as Record<string, unknown>

  const triggerHandlers = {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      const originalRef = (children as unknown as { ref?: unknown }).ref
      if (typeof originalRef === 'function') {
        originalRef(node)
      } else if (originalRef && typeof originalRef === 'object' && 'current' in (originalRef as object)) {
        ;(originalRef as { current: unknown }).current = node
      }
    },
    onMouseEnter: (e: React.MouseEvent) => {
      const origin = childProps.onMouseEnter as ((e: React.MouseEvent) => void) | undefined
      origin?.(e)
      show()
    },
    onMouseLeave: (e: React.MouseEvent) => {
      const origin = childProps.onMouseLeave as ((e: React.MouseEvent) => void) | undefined
      origin?.(e)
      hide()
    },
    onFocus: (e: React.FocusEvent) => {
      const origin = childProps.onFocus as ((e: React.FocusEvent) => void) | undefined
      origin?.(e)
      show()
    },
    onBlur: (e: React.FocusEvent) => {
      const origin = childProps.onBlur as ((e: React.FocusEvent) => void) | undefined
      origin?.(e)
      hide()
    },
  }

  // Strip native title to avoid double-tooltip flicker (browser native + custom).
  const stripNativeTitle = childProps.title !== undefined ? { title: undefined } : null

  const clone = cloneElement(
    children,
    { ...stripNativeTitle, ...triggerHandlers } as Record<string, unknown>,
  )

  const { node: contentNode, multiline } = renderContent(content)

  const bubbleStyle: CSSProperties | null = state
    ? {
        position: 'fixed',
        top: state.y,
        left: state.x,
        transform: transformFor(state.placement),
        zIndex: 10_000,
        pointerEvents: 'none',
        background: 'var(--bg-0)',
        color: 'var(--text-1)',
        border: '1px solid var(--border)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
        padding: '6px 10px',
        borderRadius: 'var(--radius-sm)',
        fontSize: 11,
        fontFamily: 'var(--sans)',
        lineHeight: 1.3,
        whiteSpace: multiline ? 'normal' : 'nowrap',
        maxWidth: 260,
        opacity: 1,
        animation: 'jarvisTooltipIn 80ms ease-out',
      }
    : null

  return (
    <>
      {clone}
      {bubbleStyle && typeof document !== 'undefined' &&
        createPortal(
          <>
            <style>{`@keyframes jarvisTooltipIn { from { opacity: 0; transform-origin: left; } to { opacity: 1; } }`}</style>
            <div style={bubbleStyle}>{contentNode}</div>
          </>,
          document.body,
        )}
    </>
  )
}
