import React from 'react';
import ReactDOM from 'react-dom';
import 'fontsource-roboto';
import './index.css';
import './popup/styles/sb-admin/sb-admin.scss';
import App from './popup/App';
import * as serviceWorker from './serviceWorker';
import { HashRouter } from 'react-router-dom';
import { BackgroundManager } from './popup/BackgroundManager';
import './popup/styles/custom.scss';
import { AppState } from './lib/MemStore';
import { signerTheme } from './popup/components/Theme';
import { ThemeProvider } from '@material-ui/core';

// Containers
import AccountManager from './popup/container/AccountManager';
import { HomeContainer } from './popup/container/HomeContainer';
import ErrorContainer from './popup/container/ErrorContainer';
import SigningContainer from './popup/container/SigningContainer';
import ConnectSignerContainer from './popup/container/ConnectSignerContainer';
import PopupContainer from './popup/container/PopupContainer';

const appState = new AppState();
const errorsContainer = new ErrorContainer();
const backgroundManager = new BackgroundManager(appState, errorsContainer);
const authContainer = new AccountManager(
  errorsContainer,
  backgroundManager,
  appState
);
const signingContainer = new SigningContainer(backgroundManager, appState);
const connectSignerContainer = new ConnectSignerContainer(
  backgroundManager,
  appState
);
const homeContainer = new HomeContainer();
const popupContainer = new PopupContainer(backgroundManager);

ReactDOM.render(
  <ThemeProvider theme={signerTheme}>
    <HashRouter>
      <App
        errors={errorsContainer}
        authContainer={authContainer}
        homeContainer={homeContainer}
        signingContainer={signingContainer}
        connectSignerContainer={connectSignerContainer}
        popupContainer={popupContainer}
      />
    </HashRouter>
  </ThemeProvider>,
  document.getElementById('root')
);

chrome.runtime.connect();

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
