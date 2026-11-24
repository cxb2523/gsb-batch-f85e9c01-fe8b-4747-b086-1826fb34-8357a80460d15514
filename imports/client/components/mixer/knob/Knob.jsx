import React from 'react';

import Hammer from 'react-hammerjs';
import { clamp, round, throttle, debounce } from 'lodash';

require('./knob.sass')

export default class Knob extends React.Component {

  constructor(props){
    super(props)

    let decimals = (this.props.step + "").split(".")[1]
    let precision = decimals ? decimals.length : 0

    // console.log(props.initVal, )
    let val = this.resolveInitialValue(props)

    this.lastEmitted = val

    this.state = {
      startingVal: 0,
      val: val,
      currentPercentage: 0,
      precision: precision,
      dragging: false
    }

    // console.log(this.props.name, this.state.val, props.initVal, props.val)
  }

  resolveInitialValue = props => {
    if (props && typeof props.initVal === 'number' && isFinite(props.initVal)) return props.initVal
    if (props && typeof props.val === 'number' && isFinite(props.val)) return props.val
    return props && props.initVal ? props.initVal : (props && props.val)
  }

  // On updates the reactive `val` is authoritative (it carries knob edits and
  // rebuilt snapshots); initVal is only a fallback.
  resolveUpdatedValue = nextProps => {
    if (nextProps && typeof nextProps.val === 'number' && isFinite(nextProps.val)) return nextProps.val
    if (nextProps && typeof nextProps.initVal === 'number' && isFinite(nextProps.initVal)) return nextProps.initVal
    return undefined
  }

  componentDidMount () {
    this.updateCurrentPercentage(this.state.val)
  }

  // After a code change rebuilds the voice, fresh props arrive for the same
  // knob. Adopt the new value unless it is exactly the value currently being
  // dragged / last emitted by this knob (avoids feedback fights).
  componentWillReceiveProps (nextProps) {
    let nextVal = this.resolveUpdatedValue(nextProps)
    if (typeof nextVal !== 'number' || !isFinite(nextVal)) return

    let rounded = parseFloat(round(nextVal, this.state.precision))
    let current = parseFloat(round(this.state.val, this.state.precision))
    let lastEmitted = parseFloat(round(this.lastEmitted, this.state.precision))

    if (rounded === current) return
    if (this.state.dragging && rounded === lastEmitted) return

    this.state.val = nextVal
    if (this.refs && this.refs.input) this.refs.input.value = round(nextVal, this.state.precision)
    this.updateCurrentPercentage(nextVal)
    this.setState({ val: nextVal })
  }

  // shouldComponentUpdate(nextProps, nextState){
  //   // return false;
  // }

  //
  // UX : touch management
  //

  throttleHandlePan = throttle(e => { this.handlePan(e) }, 200)

  handlePan = e => {
    e.preventDefault()
    let variator = (this.props.max / 200) * e.deltaY

    this.state.val =  clamp(parseFloat(round(this.state.startingVal + variator, this.state.precision)), this.props.min, this.props.max)

    this.refs.input.value = round(this.state.val, this.state.precision)

    this.changeValue()
  }

  handlePanStart = e => {
    console.log('handlePanStart')
    e.preventDefault()
    this.setState({startingVal: this.state.val, dragging: true})
  }

  handlePanEnd = e => {
    this.setState({ dragging: false })
  }

  modifyValueByInput = e => {
    this.state.val = parseFloat(e.target.value)

    this.changeValue()
  }

  // UI

  updateCurrentPercentage = explicitVal => {
    let val = typeof explicitVal === 'number' ? explicitVal : this.state.val
    let aPercent = ( this.props.max - this.props.min ) / 100
    let currentRelativePosition = val - this.props.min
    let currentPercentage = currentRelativePosition / aPercent

    this.setState({currentPercentage: currentPercentage})
  }

  //
  // DATA FLOW
  //

  changeValue = () => {
    this.lastEmitted = this.state.val
    this.updateCurrentPercentage()
    this.props.onValueChange(this.state.val)
  }

  // throttleChangeValue = throttle(() => {
  //   this.updateCurrentPercentage()
  //   this.props.onValueChange(this.state.val)
  // }, 50)

	render() {
		return (
      <div className="component-knob">
        <Hammer
          onPan={this.handlePan}
          onPanStart={this.handlePanStart}
          onPanEnd={this.handlePanEnd}
          direction="DIRECTION_VERTICAL"
          options={this.state.hammerOptions}>
          <div>
            <div className="name"> {this.props.name} </div>
            <div className="knob" style={{transform: `rotate(${(this.state.currentPercentage * 3.60)}deg)`}}>
            </div>
            <input
              className="number"
              type="number"
              min={this.props.min}
              max={this.props.max}
              step={this.props.step}
              ref="input"
              defaultValue={round(this.state.val, this.state.precision)}
              onChange={this.modifyValueByInput} />
          </div>
        </Hammer>
      </div>
    )
  }
}
