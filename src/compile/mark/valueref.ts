/**
 * Utility files for producing Vega ValueRef for marks
 */
import {SignalRef} from 'vega';
import {isArray, isFunction, isString, stringValue} from 'vega-util';
import {isBinned, isBinning} from '../../bin';
import {Channel, getMainRangeChannel, X, X2, Y, Y2} from '../../channel';
import {Config} from '../../config';
import {Encoding, forEach} from '../../encoding';
import {
  binRequiresRange,
  ChannelDef,
  ChannelDefWithCondition,
  FieldDef,
  FieldDefBase,
  FieldRefOption,
  format,
  hasConditionalFieldDef,
  isFieldDef,
  isTypedFieldDef,
  isValueDef,
  SecondaryFieldDef,
  title,
  TypedFieldDef,
  vgField
} from '../../fielddef';
import * as log from '../../log';
import {Mark, MarkDef} from '../../mark';
import {hasDiscreteDomain, ScaleType} from '../../scale';
import {StackProperties} from '../../stack';
import {QUANTITATIVE} from '../../type';
import {contains, some} from '../../util';
import {VgValueRef} from '../../vega.schema';
import {formatSignalRef} from '../common';
import {ScaleComponent} from '../scale/component';

// TODO: we need to find a way to refactor these so that scaleName is a part of scale
// but that's complicated.  For now, this is a huge step moving forward.

/**
 * @return Vega ValueRef for normal x- or y-position without projection
 */
export function position(params: {
  channel: 'x' | 'y';
  channelDef: ChannelDef;
  channel2Def?: ChannelDef<SecondaryFieldDef<string>>;
  scaleName: string;
  scale: ScaleComponent;
  stack?: StackProperties;
  offset: number;
  defaultRef: VgValueRef | (() => VgValueRef);
}): VgValueRef {
  const {channel, channelDef, scaleName, stack, offset} = params;
  if (isFieldDef(channelDef) && stack && channel === stack.fieldChannel) {
    // x or y use stack_end so that stacked line's point mark use stack_end too.
    return fieldRef(channelDef, scaleName, {suffix: 'end'}, {offset});
  }
  return midPoint(params);
}

/**
 * @return Vega ValueRef for normal x2- or y2-position without projection
 */
export function position2({
  channel,
  channelDef,
  channel2Def,
  scaleName,
  scale,
  stack,
  offset,
  defaultRef
}: {
  channel: 'x2' | 'y2';
  channelDef: ChannelDef;
  channel2Def: ChannelDef;
  scaleName: string;
  scale: ScaleComponent;
  stack: StackProperties;
  offset: number;
  defaultRef: VgValueRef | (() => VgValueRef);
}): VgValueRef {
  if (
    isFieldDef(channelDef) &&
    stack &&
    // If fieldChannel is X and channel is X2 (or Y and Y2)
    channel.charAt(0) === stack.fieldChannel.charAt(0)
  ) {
    return fieldRef(channelDef, scaleName, {suffix: 'start'}, {offset});
  }
  return midPoint({channel, channelDef: channel2Def, scaleName, scale, stack, offset, defaultRef});
}

export function getOffset(channel: 'x' | 'y' | 'x2' | 'y2', markDef: MarkDef) {
  const offsetChannel = channel + 'Offset';
  // TODO: in the future read from encoding channel too

  const markDefOffsetValue = markDef[offsetChannel];
  if (markDefOffsetValue) {
    return markDefOffsetValue;
  }

  return undefined;
}

/**
 * Value Ref for binned fields
 */
export function bin(fieldDef: TypedFieldDef<string>, scaleName: string, side: 'start' | 'end', offset?: number) {
  const binSuffix = side === 'start' ? undefined : 'end';
  return fieldRef(fieldDef, scaleName, {binSuffix}, offset ? {offset} : {});
}

export function fieldRef(
  fieldDef: FieldDefBase<string>,
  scaleName: string,
  opt: FieldRefOption,
  mixins: {offset?: number | VgValueRef; band?: number | boolean}
): VgValueRef {
  const ref: VgValueRef = {
    ...(scaleName ? {scale: scaleName} : {}),
    field: vgField(fieldDef, opt)
  };

  if (mixins) {
    const {offset, band} = mixins;
    return {
      ...ref,
      ...(offset ? {offset} : {}),
      ...(band ? {band} : {})
    };
  }
  return ref;
}

export function bandRef(scaleName: string, band: number | boolean = true): VgValueRef {
  return {
    scale: scaleName,
    band: band
  };
}

/**
 * Signal that returns the middle of a bin from start and end field. Should only be used with x and y.
 */
function binMidSignal({
  scaleName,
  fieldDef,
  fieldDef2,
  offset
}: {
  scaleName: string;
  fieldDef: TypedFieldDef<string>;
  fieldDef2?: SecondaryFieldDef<string>;
  offset: number;
}) {
  const start = vgField(fieldDef, {expr: 'datum'});
  const end =
    fieldDef2 !== undefined
      ? vgField(fieldDef2, {expr: 'datum'})
      : vgField(fieldDef, {binSuffix: 'end', expr: 'datum'});

  return {
    signal: `scale("${scaleName}", (${start} + ${end}) / 2)`,
    ...(offset ? {offset} : {})
  };
}

/**
 * @returns {VgValueRef} Value Ref for xc / yc or mid point for other channels.
 */
export function midPoint({
  channel,
  channelDef,
  channel2Def,
  scaleName,
  scale,
  stack,
  offset,
  defaultRef
}: {
  channel: Channel;
  channelDef: ChannelDef;
  channel2Def?: ChannelDef<SecondaryFieldDef<string>>;
  scaleName: string;
  scale: ScaleComponent;
  stack?: StackProperties;
  offset?: number;
  defaultRef: VgValueRef | (() => VgValueRef);
}): VgValueRef {
  // TODO: datum support
  if (channelDef) {
    /* istanbul ignore else */

    if (isFieldDef(channelDef)) {
      if (isTypedFieldDef(channelDef)) {
        if (isBinning(channelDef.bin)) {
          // Use middle only for x an y to place marks in the center between start and end of the bin range.
          // We do not use the mid point for other channels (e.g. size) so that properties of legends and marks match.
          if (contains([X, Y], channel) && channelDef.type === QUANTITATIVE) {
            if (stack && stack.impute) {
              // For stack, we computed bin_mid so we can impute.
              return fieldRef(channelDef, scaleName, {binSuffix: 'mid'}, {offset});
            }
            // For non-stack, we can just calculate bin mid on the fly using signal.
            return binMidSignal({scaleName, fieldDef: channelDef, offset});
          }
          return fieldRef(channelDef, scaleName, binRequiresRange(channelDef, channel) ? {binSuffix: 'range'} : {}, {
            offset
          });
        } else if (isBinned(channelDef.bin)) {
          if (isFieldDef(channel2Def)) {
            return binMidSignal({scaleName, fieldDef: channelDef, fieldDef2: channel2Def, offset});
          } else {
            const channel2 = channel === X ? X2 : Y2;
            log.warn(log.message.channelRequiredForBinned(channel2));
          }
        }
      }

      if (scale) {
        const scaleType = scale.get('type');
        if (hasDiscreteDomain(scaleType)) {
          if (scaleType === 'band') {
            // For band, to get mid point, need to offset by half of the band
            return fieldRef(channelDef, scaleName, {binSuffix: 'range'}, {band: 0.5, offset});
          }
          return fieldRef(channelDef, scaleName, {binSuffix: 'range'}, {offset});
        }
      }
      return fieldRef(channelDef, scaleName, {}, {offset}); // no need for bin suffix
    } else if (isValueDef(channelDef)) {
      const value = channelDef.value;
      const offsetMixins = offset ? {offset} : {};

      if (contains(['x', 'x2'], channel) && value === 'width') {
        return {field: {group: 'width'}, ...offsetMixins};
      } else if (contains(['y', 'y2'], channel) && value === 'height') {
        return {field: {group: 'height'}, ...offsetMixins};
      }

      return {value, ...offsetMixins};
    }

    // If channelDef is neither field def or value def, it's a condition-only def.
    // In such case, we will use default ref.
  }

  return isFunction(defaultRef) ? defaultRef() : defaultRef;
}

export function tooltipForEncoding(encoding: Encoding<string>, config: Config) {
  const keyValues: string[] = [];
  const usedKey = {};

  function add(fieldDef: TypedFieldDef<string> | SecondaryFieldDef<string>, channel: Channel) {
    const mainChannel = getMainRangeChannel(channel);
    if (channel !== mainChannel) {
      fieldDef = {
        ...fieldDef,
        type: encoding[mainChannel].type
      };
    }

    const key = title(fieldDef, config, {allowDisabling: false});
    const value = text(fieldDef, config).signal;

    if (!usedKey[key]) {
      keyValues.push(`${stringValue(key)}: ${value}`);
    }
    usedKey[key] = true;
  }

  forEach(encoding, (channelDef, channel) => {
    if (isFieldDef(channelDef)) {
      add(channelDef, channel);
    } else if (hasConditionalFieldDef(channelDef)) {
      add(channelDef.condition, channel);
    }
  });
  return keyValues.length ? {signal: `{${keyValues.join(', ')}}`} : undefined;
}

export function text(
  channelDef: ChannelDefWithCondition<FieldDef<string>, string | number | boolean>,
  config: Config
): VgValueRef {
  // text
  if (channelDef) {
    if (isValueDef(channelDef)) {
      return {value: channelDef.value};
    }
    if (isTypedFieldDef(channelDef)) {
      return formatSignalRef(channelDef, format(channelDef), 'datum', config);
    }
  }
  return undefined;
}

export function mid(sizeRef: SignalRef): VgValueRef {
  return {...sizeRef, mult: 0.5};
}

/**
 * Whether the scale definitely includes zero in the domain
 */
function domainDefinitelyIncludeZero(scale: ScaleComponent) {
  if (scale.get('zero') !== false) {
    return true;
  }
  const domains = scale.domains;
  if (isArray(domains)) {
    return some(domains, d => isArray(d) && d.length === 2 && d[0] <= 0 && d[1] >= 0);
  }
  return false;
}

export function getDefaultRef(
  defaultRef: VgValueRef | 'zeroOrMin' | 'zeroOrMax',
  channel: 'x' | 'y',
  scaleName: string,
  scale: ScaleComponent,
  mark: Mark
) {
  return () => {
    if (isString(defaultRef)) {
      if (scaleName) {
        const scaleType = scale.get('type');
        if (contains([ScaleType.LOG, ScaleType.TIME, ScaleType.UTC], scaleType)) {
          // Log scales cannot have zero.
          // Zero in time scale is arbitrary, and does not affect ratio.
          // (Time is an interval level of measurement, not ratio).
          // See https://en.wikipedia.org/wiki/Level_of_measurement for more info.
          if (mark === 'bar' || mark === 'area') {
            log.warn(log.message.nonZeroScaleUsedWithLengthMark(mark, channel, {scaleType}));
          }
        } else {
          if (domainDefinitelyIncludeZero(scale)) {
            return {
              scale: scaleName,
              value: 0
            };
          }
          if (mark === 'bar' || mark === 'area') {
            log.warn(
              log.message.nonZeroScaleUsedWithLengthMark(mark, channel, {zeroFalse: scale.explicit.zero === false})
            );
          }
        }
      }

      if (defaultRef === 'zeroOrMin') {
        return channel === 'x' ? {value: 0} : {field: {group: 'height'}};
      } else {
        // zeroOrMax
        return channel === 'x' ? {field: {group: 'width'}} : {value: 0};
      }
    }
    return defaultRef;
  };
}
