#!/usr/bin/env bash
# https://developer.apple.com/library/content/technotes/tn2450/_index.html
# https://opensource.apple.com/source/IOHIDFamily/IOHIDFamily-1035.41.2/IOHIDFamily/IOHIDUsageTables.h.auto.html
# https://opensource.apple.com/source/IOHIDFamily/IOHIDFamily-1035.41.2/IOHIDFamily/AppleHIDUsageTables.h.auto.html
# /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/Carbon.framework/Versions/A/Frameworks/HIToolbox.framework/Versions/A/Headers/Events.h
FROM="\"HIDKeyboardModifierMappingSrc\""
TO="\"HIDKeyboardModifierMappingDst\""

ESCAPE="0x700000029"
BACKTICK="0x700000035"
CAPS_LOCK="0x700000039"
DELETE="0x70000004C"
VOL_UP="0x700000048"
VOL_DOWN="0x700000049"

PRINT_SCREEN="0x700000046"
SCROLL_LOCK="0x700000047"
PAUSE="0x700000048"
INSERT="0x700000049"

F13="0x700000068"
F14="0x700000069"
F15="0x70000006A"

LEFT_ALT="0x7000000E2"
LEFT_GUI="0x7000000E3"
RIGHT_CTRL="0x7000000E4"
RIGHT_ALT="0x7000000E6"
RIGHT_GUI="0x7000000E7"
PC_MENU="0x700000065"

MEDIA_PLAY="0xC000000B0"
MEDIA_NEXT="0xC000000B5"
MEDIA_PREV="0xC000000B6"
MEDIA_EJECT="0xC000000B8"

# Leopold FC660C
hidutil property --matching '{"ProductID":0x134, "VendorID":0x853}' --set "{\"UserKeyMapping\":[
{$FROM: $INSERT,       $TO: $BACKTICK},
{$FROM: $DELETE,       $TO: $MEDIA_PLAY},
{$FROM: $SCROLL_LOCK,  $TO: $MEDIA_PREV},
{$FROM: $PAUSE,        $TO: $MEDIA_NEXT},
{$FROM: $RIGHT_ALT,        $TO: $RIGHT_GUI},
]}"
