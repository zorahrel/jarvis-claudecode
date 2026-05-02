import ContextTab from '../components/ContextTab'

interface Props {
  onToast?: (msg: string, kind?: 'info' | 'success' | 'error') => void
}

// onToast accepted for consistency with other pages but not used by ContextTab v1
// (no toast-worthy events in the polling cycle yet).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function Context(_props: Props) {
  return <ContextTab />
}

export default Context
