// A render error shows a message and a way back, instead of closing the app.
import React from 'react'
import { Button, P, Problem, Screen } from './kit'

export class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <Screen bottom={<Button label="Back to the wallet" onPress={() => this.setState({ error: null })} />}>
        <P>Something went wrong on this screen.</P>
        <Problem>{this.state.error.message}</Problem>
        <P muted>Nothing was signed or sent by this screen. Your wallet is unchanged.</P>
      </Screen>
    )
  }
}
