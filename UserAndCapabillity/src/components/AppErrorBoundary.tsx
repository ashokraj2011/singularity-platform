import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

type State = {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Identity app failed to render', error, info)
  }

  reset = () => {
    localStorage.removeItem('iam-auth')
    localStorage.removeItem('event-horizon.iam.session')
    localStorage.removeItem('event-horizon.iam.session-id')
    window.location.assign('/login')
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F0F4F8] p-6">
        <div className="w-full max-w-xl rounded-2xl border border-red-200 bg-white p-6 shadow-lg">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-red-600">Identity app recovery</p>
          <h1 className="mt-2 text-2xl font-bold text-[#0A2240]">The dashboard could not finish loading.</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            The app caught a browser-side render error instead of leaving a blank screen. Clear the local session and sign in again.
          </p>
          <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={this.reset}
            className="mt-5 rounded-lg bg-[#00843D] px-4 py-2 text-sm font-bold text-white hover:bg-[#006236]"
          >
            Clear session and return to login
          </button>
        </div>
      </div>
    )
  }
}
