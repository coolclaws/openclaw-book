import DefaultTheme from 'vitepress/theme'
import SidebarToggle from './SidebarToggle.vue'
import { h } from 'vue'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-before': () => h(SidebarToggle),
    })
  },
}
