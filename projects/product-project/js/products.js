/* global $ _ */
$(function(){
// $(document).ready(function () {
  // ALL YOUR CODE GOES BELOW HERE //
    $.getJSON('data/product.json', function (data) {
   
   
//               function search(data, target){
//     function find(data, target){
//         if(typeof data === "string"){
//             return data.includes(target);
//         }
//         if(typeof data === "object")
    
//      return _.some(data, target)   
//     }
    
//     return _.filter (data, find)
// } //search bar

  
    
  
    
//   let $section = $('<section>').attr('id', 'top');
//       $section.appendTo($('main'));
    
// //   let $sectionlist = $('<section>').attr('id', 'list');
// //             $sectionlist.appendTo($('section'));
            
// $('li').css('background-color', 'red').css('border-radius', '1px');




function display(array){
          $('main').empty();
          if(array.length===0){
              $('<div>').text('No Items Found').attr('class','text-center').css('font-size','20px').css('font-weight','bold').appendTo('main');
          }
          _.each(array, function(product){
              let row = $('<article>').attr('class','row').css('border-bottom','1px dotted #ccc');    /////hyperlink
              let thumbnail = 'img/product/thumbs/'+ product.image;
              $('<img>').attr('src',thumbnail).attr('class','col-md-2').appendTo(row);
              let mainDesc = $('<section>').attr('class','col-md-6').appendTo(row);
              $('<a>').text(product.desc).appendTo(mainDesc);
            
            
            
            
            
// ------------------------modal clicker feature --------------------------------
            
            //   $('main').append(modalFactory(product));
            //     row.on('click', function(){
            //         $("#"+product.id+"-modal").modal();
            //     });
             
              row.appendTo('main')
              $('<div>').text('Price: $'+product.price).appendTo(mainDesc).css('font-size','12px');
                    if(product.stock < 10){
                        $('<section>').text("Only "+product.stock+" left in-stock!!! BUY IT NOW").css('color','red').css('font-size','25px').appendTo(mainDesc);
                    }else{
                        $('<section>').text(product.stock+" left in-stock").appendTo(mainDesc);
                    }
              $('<button>').text("Gimme Dat Stuff").appendTo(row).on('click',function(event){alert('Yay you bought dat'+product.desc)}).attr('class','text-center');
          });
          
      }
      display(data);
      
         
        //  let list = data;
        // //  $section.append($('<article>')).attr('class', 'row')
        //  _.map(data,function(item){
        //         $('<article>').attr('class', 'row')
        //         $('<img>').attr( 'src','img/product/thumbs/'+item.image).attr('class', 'col-md-2').appendTo('.row')
        //         let $x= $('<section>').attr('class', 'col-md-8').appendTo('.row')
        //         // $('<a>').text("Description : " + item.desc).appendTo($x)
        //         // $('<div>').text("Price:  " + item.price).appendTo($x);
        //         // $('<div>').text("Color:  " + item.color).appendTo($x);            
                // $('<div>').text("Stock : " + item.stock).appendTo($x); 
//  $('<article>').attr('class', 'row').appendTo('main')
                
          //  });
            
            
            
            
            
   
     
       
        
           //  $('li').append('<img  src="img/product/thumbs/galaxy6-gold.jpg"  />' ) ;         






/* ( function( window ) {
	
	function UISearch( el, options ) {	
		this.el = el;
		this.inputEl = el.querySelector( 'form > input.sb-search-input' );
		this._initEvents();
	}

	UISearch.prototype = {
		_initEvents : function() {
			var self = this,
				initSearchFn = function( ev ) {
					if( !classie.has( self.el, 'sb-search-open' ) ) { // open it
						ev.preventDefault();
						self.open();
					}
					else if( classie.has( self.el, 'sb-search-open' ) && /^\s*$/.test( self.inputEl.value ) ) { // close it
						self.close();
					}
				}

			this.el.addEventListener( 'click', initSearchFn );
			this.inputEl.addEventListener( 'click', function( ev ) { ev.stopPropagation(); });
		},
		open : function() {
			classie.add( this.el, 'sb-search-open' );
		},
		close : function() {
			classie.remove( this.el, 'sb-search-open' );
		}
	}

	// add to global namespace
	window.UISearch = UISearch;

} )( window ) */
         
        

/*  $sectionrec {display: block;  
          background: white;  
          border: 1px solid blue;  
          padding: 20px;  
          margin: 40px;
  }

  */    
      
      
      
    }).fail(function(){console.log('noJSON');});
  
  
  
  
  // ALL YOUR CODE GOES ABOVE HERE //
}); 

