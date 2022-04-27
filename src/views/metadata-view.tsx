import {css} from 'aphrodite'
import {h} from 'preact'
import yaml from 'js-yaml'

import {getFlamechartStyle} from './flamechart-style'
import {useTheme} from './themes/theme'
import {CallTreeNode} from '../lib/profile'

interface MetadataViewProps {
  node: CallTreeNode
}

export function MetadataView({node}: MetadataViewProps) {
  const style = getFlamechartStyle(useTheme())

  if (!node.frame.meta) return null

  return <pre className={css(style.metadata)}>{yaml.dump(node.frame.meta)}</pre>
}
