/**
 * Renders every plugin contribution registered for a named slot.
 *
 * Drop `<ExtensionSlot name="dashboard.widgets" />` wherever the app is willing to
 * accept contributed UI. Placing a slot is a *promise*: it becomes public API that
 * plugins depend on, so add them deliberately rather than everywhere.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

import { contributionsFor, type SlotContext, type SlotName } from './registry'

interface BoundaryProps {
  name: string
  children: ReactNode
}

/**
 * Isolates a single contribution.
 *
 * Without this, one plugin throwing during render unmounts the whole React tree —
 * a third-party bug becoming a total outage for the tenant.
 */
class ContributionBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`extension contribution "${this.props.name}" failed to render`, error, info)
  }

  render() {
    if (this.state.failed) return null
    return this.props.children
  }
}

export function ExtensionSlot({
  name,
  context = {},
}: {
  name: SlotName
  context?: SlotContext
}) {
  const contributions = contributionsFor(name)
  if (contributions.length === 0) return null

  return (
    <>
      {contributions.map(({ id, component: Contribution }) => (
        <ContributionBoundary key={id} name={`${name}/${id}`}>
          <Contribution context={context} />
        </ContributionBoundary>
      ))}
    </>
  )
}
