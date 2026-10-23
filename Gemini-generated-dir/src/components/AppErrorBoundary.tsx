import React from 'react';

interface AppErrorBoundaryProps {
  appName: string;
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  mountCount: number;
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, mountCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[AppErrorBoundary] "${this.props.appName}" crashed:`, error, info);
  }

  componentDidMount() {
    this.setState((prev) => ({ mountCount: prev.mountCount + 1 }));
  }

  handleRestart = () => {
    // Guard against infinite re-mount loops (>5 restarts)
    if (this.state.mountCount > 5) {
      console.warn(`[AppErrorBoundary] "${this.props.appName}" exceeded restart limit.`);
      return;
    }
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const { error } = this.state;
      const tooManyRestarts = this.state.mountCount > 5;
      return (
        <div className="flex flex-col items-center justify-center w-full h-full bg-neutral-900 text-slate-100 p-6 gap-4">
          <div className="text-5xl select-none">❌</div>
          <div className="text-center">
            <p className="text-base font-semibold text-red-400">{this.props.appName} has crashed</p>
            {error && (
              <p className="mt-1 text-xs text-slate-400 font-mono max-w-xs break-words">
                {error.name}: {error.message}
              </p>
            )}
          </div>
          {tooManyRestarts ? (
            <p className="text-xs text-amber-400">Too many restarts. Please close and reopen the app.</p>
          ) : (
            <button
              type="button"
              onClick={this.handleRestart}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
            >
              Restart App
            </button>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
