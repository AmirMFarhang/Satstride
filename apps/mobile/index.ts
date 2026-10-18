import 'react-native-get-random-values'
import { registerRootComponent } from 'expo'
// before the app's modules: a safe import.meta.url for shared src/ files (see the file)
import './src/app/import-meta'
import App from './App'

registerRootComponent(App)
