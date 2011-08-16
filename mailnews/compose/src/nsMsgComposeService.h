/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is mozilla.org code.
 *
 * The Initial Developer of the Original Code is
 * Netscape Communications Corporation.
 * Portions created by the Initial Developer are Copyright (C) 1998
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Jean-Francois Ducarroz <ducarroz@netscape.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either of the GNU General Public License Version 2 or later (the "GPL"),
 * or the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

#define MSGCOMP_TRACE_PERFORMANCE 1

#include "nsIMsgComposeService.h"
#include "nsCOMPtr.h"
#include "nsIDOMWindow.h"
#include "nsIObserver.h"
#include "nsWeakReference.h"
#include "nsIMimeStreamConverter.h"
#include "nsInterfaceHashtable.h"

#include "nsICommandLineHandler.h"
#define ICOMMANDLINEHANDLER nsICommandLineHandler

class nsMsgCachedWindowInfo
{
public:
  void Initialize(nsIDOMWindow *aWindow, nsIMsgComposeRecyclingListener *aListener, PRBool aHtmlCompose)
  {
    window = aWindow;
    listener = aListener;
    htmlCompose = aHtmlCompose;
  }
    
  void Clear()
  {
    window = nsnull;
    listener = nsnull;
  }
  
  nsCOMPtr<nsIDOMWindow>                    window;
  nsCOMPtr<nsIMsgComposeRecyclingListener>  listener;
  PRBool                                    htmlCompose;
};

class nsMsgComposeService : 
  public nsIMsgComposeService,
  public nsIObserver,
  public ICOMMANDLINEHANDLER,
  public nsSupportsWeakReference
{
public: 
	nsMsgComposeService();
	virtual ~nsMsgComposeService();

	NS_DECL_ISUPPORTS
  NS_DECL_NSIMSGCOMPOSESERVICE
  NS_DECL_NSIOBSERVER
  NS_DECL_NSICOMMANDLINEHANDLER

  nsresult Init();
  void Reset();
  void DeleteCachedWindows();
  nsresult AddGlobalHtmlDomains();

private:
  PRBool mLogComposePerformance;

  PRInt32 mMaxRecycledWindows;
  nsMsgCachedWindowInfo *mCachedWindows;
  
  void CloseHiddenCachedWindow(nsIDOMWindow *domWindow);

  nsresult LoadDraftOrTemplate(const nsACString& aMsgURI, nsMimeOutputType aOutType, 
                               nsIMsgIdentity * aIdentity, const char * aOriginalMsgURI, 
                               nsIMsgDBHdr * aOrigMsgHdr, PRBool aForwardInline,
                               PRBool overrideComposeFormat,
                               nsIMsgWindow *aMsgWindow);

  nsresult RunMessageThroughMimeDraft(const nsACString& aMsgURI,
                                      nsMimeOutputType aOutType,
                                      nsIMsgIdentity * aIdentity,
                                      const char * aOriginalMsgURI,
                                      nsIMsgDBHdr * aOrigMsgHdr,
                                      PRBool aForwardInline,
                                      const nsAString &forwardTo,
                                      PRBool overrideComposeFormat,
                                      nsIMsgWindow *aMsgWindow);

  nsresult ShowCachedComposeWindow(nsIDOMWindow *aComposeWindow, PRBool aShow);

  // hash table mapping dom windows to nsIMsgCompose objects
  nsInterfaceHashtable<nsISupportsHashKey, nsIWeakReference> mOpenComposeWindows;

  // When doing a reply and the settings are enabled, get the HTML of the selected text
  // in the original message window so that it can be quoted instead of the entire message.
  nsresult GetOrigWindowSelection(MSG_ComposeType type, nsIMsgWindow *aMsgWindow, nsACString& aSelHTML);

#ifdef MSGCOMP_TRACE_PERFORMANCE
  PRIntervalTime            mStartTime;
  PRIntervalTime            mPreviousTime;
#endif
};
