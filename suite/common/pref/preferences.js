/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The content of this file is loaded into the scope of the
// prefwindow and will be available to all prefpanes!

function EnableElementById(aElementId, aEnable, aFocus)
{
  EnableElement(document.getElementById(aElementId), aEnable, aFocus);
}

function EnableElement(aElement, aEnable, aFocus)
{
  let pref = document.getElementById(aElement.getAttribute("preference"));
  let enabled = aEnable && !pref.locked;

  aElement.disabled = !enabled;

  if (enabled && aFocus)
    aElement.focus();
}

function WriteSoundField(aField, aValue)
{
  var file = GetFileFromString(aValue);
  if (file)
  {
    aField.file = file;
    aField.label = (/Mac/.test(navigator.platform)) ? file.leafName : file.path;
  }
}

function SelectSound(aSoundUrlPref)
{
  const nsIFilePicker = Components.interfaces.nsIFilePicker;
  var fp = Components.classes["@mozilla.org/filepicker;1"]
                     .createInstance(nsIFilePicker);
  var prefutilitiesBundle = document.getElementById("bundle_prefutilities");
  fp.init(window, prefutilitiesBundle.getString("choosesound"),
          nsIFilePicker.modeOpen);

  var file = GetFileFromString(aSoundUrlPref.value);
  if (file && file.parent && file.parent.exists())
    fp.displayDirectory = file.parent;

  var filterExts = "*.wav; *.wave";
  // On Mac, allow AIFF and CAF files too.
  if (/Mac/.test(navigator.platform))
    filterExts += "; *.aif; *.aiff; *.caf";
  fp.appendFilter(prefutilitiesBundle.getString("SoundFiles"), filterExts);
  fp.appendFilters(nsIFilePicker.filterAll);

  if (fp.show() == nsIFilePicker.returnOK)
    aSoundUrlPref.value = fp.fileURL.spec;
}

function PlaySound(aValue, aMail)
{
  const nsISound = Components.interfaces.nsISound;
  var sound = Components.classes["@mozilla.org/sound;1"]
                        .createInstance(nsISound);

  if (aValue)
    sound.play(Services.io.newURI(aValue, null, null));
  else if (aMail && !/Mac/.test(navigator.platform))
    sound.playEventSound(nsISound.EVENT_NEW_MAIL_RECEIVED);
  else
    sound.beep();
}

function LoadEncodingLabels(aMenulist, aPref)
{
  var bundle = document.getElementById("bundle_prefutilities");
  var defaultLabel = bundle.getString("labelDefaultFont");
  var list = document.getElementById(aMenulist);
  var encoding = aPref ? document.getElementById(aPref).defaultValue :
    GuessDefaultEncoding();
  bundle = document.getElementById("charsetTitlesBundle");
  encoding = bundle.getString(encoding.toLowerCase() + ".title")
                   .replace(/.*\(|\).*/g, "");
  var item = list.firstChild.firstChild;
  item.setAttribute("label", defaultLabel.replace("%font_family%", encoding));
  while ((item = item.nextSibling))
    item.setAttribute("label", bundle.getString(item.getAttribute("value").toLowerCase() + ".title"));
}

function GuessDefaultEncoding()
{
  switch (Components.classes["@mozilla.org/chrome/chrome-registry;1"]
                    .getService(Components.interfaces.nsIXULChromeRegistry)
                    .getSelectedLocale("global").split("-")[0]) {
    case "ar": case "fa":
      return "windows-1256";
    case "ba": case "be": case "bg": case "kk": case "ky": case "mk":
    case "ru": case "sah": case "sr": case "tg": case "tt": case "uk":
      return "windows-1251";
    case "cs": case "hr": case "sk":
      return "windows-1250";
    case "el":
      return "iso-8859-7";
    case "et": case "lt": case "lv":
      return "windows-1257";
    case "he":
      return "windows-1255";
    case "hu": case "pl": case "sl":
      return "iso-8859-2";
    case "ko":
      return "euc-kr";
    case "ku": case "tr":
      return "windows-1254";
    case "th":
      return "windows-874";
    case "vi":
      return "windows-1258";
    case "zh":
      return "gbk";
  }
  return "windows-1252";
}
