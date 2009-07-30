/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
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
 *   Alec Flett <alecf@netscape.com>
 *   Seth Spitzer <sspitzer@netscape.com>
 *   Håkan Waara <hwaara@chello.se>
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

var gCurrentDomain;
var gPrefsBundle;

function identityPageValidate()
{
  var canAdvance = false;
  var name = document.getElementById("fullName").value;
  var email = trim(document.getElementById("email").value);

  if (name && email) {
    canAdvance = gCurrentDomain ? emailNameIsLegal(email) : emailNameAndDomainAreLegal(email);

    if (gCurrentDomain && canAdvance) {
      // For prefilled ISP data we must check if the account already exists as
      // there is no second chance. The email is the username since the user
      // fills in [______]@example.com.
      var pageData = parent.GetPageData();
      var serverType = parent.getCurrentServerType(pageData);
      var hostName = parent.getCurrentHostname(pageData);
      var usernameWithDomain = email + "@" + gCurrentDomain;
      if (parent.AccountExists(email, hostName, serverType) ||
          parent.AccountExists(usernameWithDomain, hostName, serverType))
        canAdvance = false;
    }
  }

  document.documentElement.canAdvance = canAdvance;
}

function identityPageUnload()
{
  var pageData = parent.GetPageData();
  var name = document.getElementById("fullName").value;
  var email = trim(document.getElementById("email").value);
  setPageData(pageData, "identity", "fullName", name);
  setPageData(pageData, "identity", "email", email);

  return true;
}

// This is for the case when the code appends the domain  
// unnecessarily.
// This simply gets rid  of "@domain" from "foo@domain"

function fixPreFilledEmail()
{
  var emailElement = document.getElementById("email");
  var email = emailElement.value;
  var emailArray = email.split('@');

  if (gCurrentDomain) {
    // check if user entered an @ sign even though we have a domain
    if (emailArray.length >= 2) {
      email = emailArray[0];
      emailElement.value = email;
    }
  }
}

/**
 * This function checks for common illegal characters.
 * It shouldn't be too strict, since we do more extensive tests later.
 */
function emailNameIsLegal(aString)
{
  return aString && !/[^!-?A-~]/.test(aString);
} 

function emailNameAndDomainAreLegal(aString)
{
  return /^[!-?A-~]+\@[A-Za-z0-9.-]+$/.test(aString);
}

function identityPageInit()
{
  gCurrentDomain = null;
  gPrefsBundle = document.getElementById("bundle_prefs");
  clearEmailTextItems();
  setEmailDescriptionText();
  checkForDomain();
  checkForFullName(); 
  checkForEmail(); 
  fixPreFilledEmail();
  identityPageValidate();
}

function clearEmailTextItems()
{
  var emailDescText = document.getElementById("emailDescText");

  if (emailDescText.firstChild)
    emailDescText.removeChild(emailDescText.firstChild);

  var postEmailText = document.getElementById("postEmailText");
  postEmailText.setAttribute("value", "");
  postEmailText.hidden = true;
}

// Use email example data that ISP has provided. ISP data, if avaialble
// for the choice user has made, will be read into CurrentAccountData. 
// Default example data from properties will be used when the info is missing. 
function setEmailDescriptionText()
{
    var emailDescText = document.getElementById("emailDescText");
    var emailFieldLabel = document.getElementById("emailFieldLabel");
    var currentAccountData = parent.gCurrentAccountData;
   
    var displayText =  null;
    var emailFieldLabelData =  null;
    var setDefaultEmailDescStrings = true; 

    // Set the default field label
    emailFieldLabel.setAttribute("value", gPrefsBundle.getString("emailFieldText"));

    // Get values for customized data from current account 
    if (currentAccountData)
    {
        var emailProvider  = currentAccountData.emailProviderName;
        var sampleEmail    = currentAccountData.sampleEmail;
        var sampleUserName = currentAccountData.sampleUserName;
        var emailIDDesc    = currentAccountData.emailIDDescription;
        var emailIDTitle   = currentAccountData.emailIDFieldTitle;

        if (emailProvider  &&
            sampleEmail    &&
            sampleUserName &&
            emailIDDesc    &&
            emailIDTitle)
        {
            // Get email description data
            displayText = gPrefsBundle.getFormattedString("customizedEmailText",
                                                          [emailProvider,
                                                           emailIDDesc,
                                                           sampleEmail,
                                                           sampleUserName]);

            // Set emailfield label
            emailFieldLabelData =  emailIDTitle;
            emailFieldLabel.setAttribute("value", emailFieldLabelData);

            // Need to display customized data. Turn off default settings.
            setDefaultEmailDescStrings = false; 
        }
    }

    if (setDefaultEmailDescStrings)
    {
        // Check for obtained values and set with default values if needed
        var username = gPrefsBundle.getString("exampleEmailUserName"); 
        var domain = gPrefsBundle.getString("exampleEmailDomain"); 

        displayText = gPrefsBundle.getFormattedString("defaultEmailText",
                                                      [username, domain]);
    }

    // Create a text nodes with text to be displayed
    var emailDescTextNode       =  document.createTextNode(displayText);

    // Display the dynamically generated text for email description 
    emailDescText.appendChild(emailDescTextNode);
}

// retrieve the current domain from the parent wizard window,
// and update the UI to add the @domain static text
function checkForDomain()
{
  var accountData = parent.gCurrentAccountData;
  if (!accountData || !accountData.domain)
    return;

  // save in global variable
  gCurrentDomain = accountData.domain;
  var postEmailText = document.getElementById("postEmailText");
  postEmailText.setAttribute("value", "@" + gCurrentDomain);
  postEmailText.hidden = false;
}

function checkForFullName() {
    var name = document.getElementById("fullName");
    if (name.value=="") {
        try {
            var userInfo = Components.classes["@mozilla.org/userinfo;1"].getService(Components.interfaces.nsIUserInfo);
            name.value = userInfo.fullname;
        }
        catch (ex) {
            // dump ("checkForFullName failed: " + ex + "\n");
        }
    }
}

function checkForEmail() 
{
    var email = document.getElementById("email");
    var pageData = parent.GetPageData();
    if (pageData && pageData.identity && pageData.identity.email) {
        email.value = pageData.identity.email.value;
    }
    if (email.value=="") {
        try {
            var userInfo = Components.classes["@mozilla.org/userinfo;1"].getService(Components.interfaces.nsIUserInfo);
            email.value = userInfo.emailAddress;
        }
        catch (ex) {
            // dump ("checkForEmail failed: " + ex + "\n"); 
        }
    }
}
